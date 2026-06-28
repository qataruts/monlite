import type { Driver } from "../driver/types.js";
import type { Monlite } from "../db.js";
import { objectId } from "../id.js";
import {
  makeVersion,
  compareVersions,
  versionTs,
  type Version,
} from "./version.js";

export type { Version } from "./version.js";
export { makeVersion, compareVersions, versionTs } from "./version.js";

export type SyncOp = "upsert" | "delete";

/** A locally-originated change ready to be pushed to a remote. */
export interface LocalChange {
  seq: number;
  collection: string;
  _id: string;
  op: SyncOp;
  version: Version;
  ts: number;
  /** Full document (with system fields) for `upsert`; absent for `delete`. */
  doc?: Record<string, any>;
}

/** A change received from a remote, to be applied locally. */
export interface RemoteChange {
  collection: string;
  _id: string;
  op: SyncOp;
  version: Version;
  doc?: Record<string, any>;
}

export type ConflictResolver = (ctx: {
  collection: string;
  _id: string;
  local: { version: Version };
  remote: { version: Version; doc?: Record<string, any> };
}) => "local" | "remote";

export interface ApplyResult {
  applied: boolean;
  conflict: boolean;
  winner: "local" | "remote" | "none";
}

export interface SyncStateRow {
  remote: string;
  cursor: string | null;
  lastPullAt: number | null;
  lastPushSeq: number | null;
  lastPushAt: number | null;
}

export interface ConflictRow {
  collection: string;
  _id: string;
  localVersion: Version;
  remoteVersion: Version;
  winner: "local" | "remote";
  ts: number;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Invalid collection name "${name}"`);
}

function stripSystem(obj: Record<string, any>): Record<string, any> {
  const { _id, created_at, updated_at, ...rest } = obj;
  return rest;
}

interface Row {
  seq: number;
  coll: string;
  doc_id: string;
  op: SyncOp;
  version: string;
  ts: number;
}

/**
 * Low-level sync primitives stored alongside the data in the same `.db` file:
 * an append-only change feed, tombstones, per-remote cursors and a conflict
 * log. Created only when a database is opened with `{ sync: true }`. The
 * `@monlite/sync` engine drives this; apps rarely touch it directly.
 */
export class SyncStore {
  readonly nodeId: string;
  private versionSeq = 0;

  constructor(
    private readonly db: Driver,
    nodeId?: string,
    private readonly mon?: Monlite,
  ) {
    this.init();
    this.nodeId = this.resolveNodeId(nodeId);
    this.versionSeq = this.initialVersionSeq();
  }

  /**
   * Resume the per-node version counter past the highest seq already recorded,
   * so a restart within the same millisecond as a prior write can't reuse a seq
   * (which would collide or mis-order under last-write-wins). Versions are
   * `<ts>:<nodeId>:<seq>` with fixed widths, so the lexicographic max for this
   * node carries the max seq.
   */
  private initialVersionSeq(): number {
    const row = this.db
      .prepare(
        `SELECT version FROM _monlite_changes WHERE version LIKE ? ORDER BY version DESC LIMIT 1`,
      )
      .get(`%:${this.nodeId}:%`) as { version: string } | undefined;
    if (!row) return 0;
    const seq = parseInt(row.version.slice(row.version.lastIndexOf(":") + 1), 10);
    return Number.isFinite(seq) ? seq + 1 : 0;
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _monlite_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        coll TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        op TEXT NOT NULL,
        version TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        pushed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS _idx_changes_doc ON _monlite_changes(coll, doc_id, seq);
      CREATE INDEX IF NOT EXISTS _idx_changes_push ON _monlite_changes(source, pushed, seq);
      CREATE TABLE IF NOT EXISTS _monlite_sync_state (
        remote TEXT PRIMARY KEY,
        cursor TEXT,
        last_pull_at INTEGER,
        last_push_seq INTEGER,
        last_push_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS _monlite_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coll TEXT, doc_id TEXT,
        local_version TEXT, remote_version TEXT,
        winner TEXT, ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS _monlite_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  private resolveNodeId(explicit?: string): string {
    if (explicit) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO _monlite_meta (key, value) VALUES ('nodeId', ?)`,
        )
        .run(explicit);
      return explicit;
    }
    const row = this.db
      .prepare(`SELECT value FROM _monlite_meta WHERE key = 'nodeId'`)
      .get() as { value: string } | undefined;
    if (row?.value) return row.value;
    const generated = objectId();
    this.db
      .prepare(`INSERT INTO _monlite_meta (key, value) VALUES ('nodeId', ?)`)
      .run(generated);
    return generated;
  }

  /** True if this database tracks sync metadata (always, once constructed). */
  get enabled(): boolean {
    return true;
  }

  /* ----------------------- local change recording ----------------------- */

  /** Append a locally-originated change to the feed. Call inside a write txn. */
  recordLocal(collection: string, id: string, op: SyncOp, ts: number): Version {
    const version = makeVersion(ts, this.nodeId, this.versionSeq++);
    this.db
      .prepare(
        `INSERT INTO _monlite_changes (coll, doc_id, op, version, ts, source, pushed)
         VALUES (?, ?, ?, ?, ?, 'local', 0)`,
      )
      .run(collection, id, op, version, ts);
    return version;
  }

  /** Current (latest) version of a document, or null if never recorded. */
  currentVersion(collection: string, id: string): Version | null {
    const row = this.db
      .prepare(
        `SELECT version FROM _monlite_changes
         WHERE coll = ? AND doc_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(collection, id) as { version: string } | undefined;
    return row?.version ?? null;
  }

  /* ----------------------------- push side ----------------------------- */

  /** Latest unpushed local change per document (the push queue). */
  pending(collections?: string[], limit?: number): LocalChange[] {
    const params: any[] = [];
    let collFilter = "";
    if (collections && collections.length) {
      collFilter = ` AND coll IN (${collections.map(() => "?").join(", ")})`;
      params.push(...collections);
    }
    let limitClause = "";
    if (limit != null && limit > 0) {
      limitClause = " LIMIT ?";
      params.push(limit);
    }
    const rows = this.db
      .prepare(
        `SELECT c.seq, c.coll, c.doc_id, c.op, c.version, c.ts
         FROM _monlite_changes c
         JOIN (
           SELECT coll, doc_id, MAX(seq) AS mseq
           FROM _monlite_changes
           WHERE source = 'local' AND pushed = 0${collFilter}
           GROUP BY coll, doc_id
         ) m ON c.coll = m.coll AND c.doc_id = m.doc_id AND c.seq = m.mseq
         ORDER BY c.seq${limitClause}`,
      )
      .all(...params) as Row[];

    return rows.map((r) => {
      const change: LocalChange = {
        seq: r.seq,
        collection: r.coll,
        _id: r.doc_id,
        op: r.op,
        version: r.version,
        ts: r.ts,
      };
      if (r.op === "upsert") {
        const doc = this.readDoc(r.coll, r.doc_id);
        if (doc) change.doc = doc;
        else change.op = "delete"; // gone since recording → treat as delete
      }
      return change;
    });
  }

  /** Mark the given changes (and any earlier local rows per doc) as pushed. */
  markPushed(changes: LocalChange[]): void {
    if (!changes.length) return;
    const stmt = this.db.prepare(
      `UPDATE _monlite_changes SET pushed = 1
       WHERE coll = ? AND doc_id = ? AND seq <= ? AND source = 'local'`,
    );
    this.db.transaction(() => {
      for (const c of changes) stmt.run(c.collection, c._id, c.seq);
    });
  }

  /* ----------------------------- pull side ----------------------------- */

  /**
   * Apply a remote change, resolving conflicts against the local version.
   * Remote-applied changes are recorded with `source='remote'` so they are
   * never pushed back (echo prevention).
   */
  applyRemote(change: RemoteChange, resolver?: ConflictResolver): ApplyResult {
    assertName(change.collection);
    // Read the local version, decide the winner, and write — all in ONE
    // transaction so the decision can't race an interleaved write.
    return this.db.transaction((): ApplyResult => {
      const localVersion = this.currentVersion(change.collection, change._id);

      let winner: "local" | "remote";
      if (localVersion === null) {
        winner = "remote";
      } else if (change.version === localVersion) {
        return { applied: false, conflict: false, winner: "none" }; // echo
      } else {
        winner = resolver
          ? resolver({
              collection: change.collection,
              _id: change._id,
              local: { version: localVersion },
              remote: { version: change.version, doc: change.doc },
            })
          : compareVersions(change.version, localVersion) > 0
            ? "remote"
            : "local";
        this.recordConflict(
          change.collection,
          change._id,
          localVersion,
          change.version,
          winner,
        );
      }

      if (winner !== "remote") {
        // Local won a real conflict. Re-enqueue it so the winning version
        // propagates back to the remote; otherwise the remote keeps the stale
        // value and the two ends diverge. (`pending` downgrades to a delete if
        // the doc no longer exists locally.)
        if (localVersion !== null) {
          this.recordLocal(change.collection, change._id, "upsert", Date.now());
        }
        return { applied: false, conflict: localVersion !== null, winner };
      }

      this.applyData(change);
      this.db
        .prepare(
          `INSERT INTO _monlite_changes (coll, doc_id, op, version, ts, source, pushed)
           VALUES (?, ?, ?, ?, ?, 'remote', 1)`,
        )
        .run(
          change.collection,
          change._id,
          change.op,
          change.version,
          versionTs(change.version),
        );

      return {
        applied: true,
        conflict: localVersion !== null,
        winner: "remote",
      };
    });
  }

  private applyData(change: RemoteChange): void {
    const ts = versionTs(change.version);
    // Route through the collection so storage respects its mode (document vs
    // structured). Structured collections must be opened with their schema
    // before their remote changes are applied — otherwise they default to
    // document mode.
    if (this.mon) {
      this.mon
        .collection(change.collection)
        .applyRemoteWrite(change.op, change._id, change.doc, ts);
      return;
    }
    // Fallback (no Monlite ref): document-mode raw write.
    const coll = change.collection;
    this.ensureCollTable(coll);
    if (change.op === "delete") {
      this.db.prepare(`DELETE FROM "${coll}" WHERE _id = ?`).run(change._id);
      return;
    }
    const doc = change.doc ?? {};
    const createdAt = typeof doc.created_at === "number" ? doc.created_at : ts;
    this.db
      .prepare(
        `INSERT INTO "${coll}" (_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(change._id, JSON.stringify(stripSystem(doc)), createdAt, ts);
  }

  /**
   * Latest change per document with `seq` greater than the given watermark,
   * as RemoteChanges (used when this database acts as a sync *source*, e.g. the
   * monlite-as-remote adapter). Returns the new watermark to resume from.
   */
  changesSince(
    seq: number,
    collections?: string[],
    limit?: number,
  ): { changes: RemoteChange[]; maxSeq: number } {
    const params: any[] = [seq];
    let collFilter = "";
    if (collections && collections.length) {
      collFilter = ` AND coll IN (${collections.map(() => "?").join(", ")})`;
      params.push(...collections);
    }
    let limitClause = "";
    if (limit != null && limit > 0) {
      limitClause = " LIMIT ?";
      params.push(limit);
    }
    const rows = this.db
      .prepare(
        `SELECT c.seq, c.coll, c.doc_id, c.op, c.version, c.ts
         FROM _monlite_changes c
         JOIN (
           SELECT coll, doc_id, MAX(seq) AS mseq
           FROM _monlite_changes
           WHERE seq > ?${collFilter}
           GROUP BY coll, doc_id
         ) m ON c.coll = m.coll AND c.doc_id = m.doc_id AND c.seq = m.mseq
         ORDER BY c.seq${limitClause}`,
      )
      .all(...params) as Row[];

    const changes: RemoteChange[] = rows.map((r) => {
      const change: RemoteChange = {
        collection: r.coll,
        _id: r.doc_id,
        op: r.op,
        version: r.version,
      };
      if (r.op === "upsert") {
        const doc = this.readDoc(r.coll, r.doc_id);
        if (doc) change.doc = doc;
        else change.op = "delete";
      }
      return change;
    });

    // Advance only to the last row we actually returned (correct under LIMIT).
    const maxSeq = rows.length ? rows[rows.length - 1]!.seq : seq;
    return { changes, maxSeq };
  }

  /* ------------------------------ bootstrap ----------------------------- */

  /**
   * Enqueue existing documents (created before sync was enabled, or never
   * recorded) as local upserts so they can be pushed. Idempotent.
   */
  seed(collections: string[]): number {
    let count = 0;
    this.db.transaction(() => {
      for (const coll of collections) {
        assertName(coll);
        if (!this.tableExists(coll)) continue; // nothing to seed yet
        const docs = this.db
          .prepare(`SELECT _id, updated_at FROM "${coll}"`)
          .all() as Array<{ _id: string; updated_at: number }>;
        for (const d of docs) {
          if (this.currentVersion(coll, d._id) !== null) continue;
          this.recordLocal(coll, d._id, "upsert", d.updated_at);
          count++;
        }
      }
    });
    return count;
  }

  /* ------------------------------- state -------------------------------- */

  getState(remote: string): SyncStateRow {
    const row = this.db
      .prepare(`SELECT * FROM _monlite_sync_state WHERE remote = ?`)
      .get(remote) as any;
    return {
      remote,
      cursor: row?.cursor ?? null,
      lastPullAt: row?.last_pull_at ?? null,
      lastPushSeq: row?.last_push_seq ?? null,
      lastPushAt: row?.last_push_at ?? null,
    };
  }

  setState(remote: string, patch: Partial<Omit<SyncStateRow, "remote">>): void {
    const cur = this.getState(remote);
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `INSERT INTO _monlite_sync_state (remote, cursor, last_pull_at, last_push_seq, last_push_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(remote) DO UPDATE SET
           cursor = excluded.cursor,
           last_pull_at = excluded.last_pull_at,
           last_push_seq = excluded.last_push_seq,
           last_push_at = excluded.last_push_at`,
      )
      .run(
        remote,
        next.cursor,
        next.lastPullAt,
        next.lastPushSeq,
        next.lastPushAt,
      );
  }

  /* ----------------------------- conflicts ------------------------------ */

  private recordConflict(
    coll: string,
    id: string,
    localVersion: Version,
    remoteVersion: Version,
    winner: "local" | "remote",
  ): void {
    this.db
      .prepare(
        `INSERT INTO _monlite_conflicts (coll, doc_id, local_version, remote_version, winner, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        coll,
        id,
        localVersion,
        remoteVersion,
        winner,
        versionTs(remoteVersion),
      );
  }

  conflicts(): ConflictRow[] {
    const rows = this.db
      .prepare(
        `SELECT coll, doc_id, local_version, remote_version, winner, ts
         FROM _monlite_conflicts ORDER BY id`,
      )
      .all() as any[];
    return rows.map((r) => ({
      collection: r.coll,
      _id: r.doc_id,
      localVersion: r.local_version,
      remoteVersion: r.remote_version,
      winner: r.winner,
      ts: r.ts,
    }));
  }

  /* ------------------------------ helpers ------------------------------- */

  private readDoc(coll: string, id: string): Record<string, any> | null {
    assertName(coll);
    // Read through the collection so structured (native-column) documents are
    // reassembled correctly, not just their JSON overflow.
    if (this.mon) return this.mon.collection(coll).getRaw(id);

    if (!this.tableExists(coll)) return null;
    const row = this.db
      .prepare(
        `SELECT _id, data, created_at, updated_at FROM "${coll}" WHERE _id = ?`,
      )
      .get(id) as
      | { _id: string; data: string; created_at: number; updated_at: number }
      | undefined;
    if (!row) return null;
    const doc = JSON.parse(row.data);
    doc._id = row._id;
    doc.created_at = row.created_at;
    doc.updated_at = row.updated_at;
    return doc;
  }

  private tableExists(name: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(name) != null
    );
  }

  private ensureCollTable(coll: string): void {
    assertName(coll);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS "${coll}" (
        _id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }
}
