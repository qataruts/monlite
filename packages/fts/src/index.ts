import type {
  Collection,
  Doc,
  Monlite,
  MonlitePlugin,
  WhereInput,
  WithId,
} from "@monlite/core";

/** Map of collection name → searchable field paths (dot-notation allowed). */
export type FtsSpec = Record<string, string[]>;

export interface SearchOptions<T = Doc> {
  /** Max results (default 50). */
  limit?: number;
  /** Additionally constrain matches with a normal monlite where clause. */
  where?: WhereInput<T>;
  /**
   * When `where` is set, how many ranked matches to pull before filtering (then
   * trimmed to `limit`). Larger = better recall for selective filters.
   * Default `max(limit * 10, 200)`.
   */
  candidates?: number;
}

export type SearchResult<T = Doc> = WithId<T> & { _score: number };

// Make `collection.search()` typed wherever @monlite/fts is imported.
declare module "@monlite/core" {
  interface Collection<T> {
    search(query: string, opts?: SearchOptions<T>): Promise<SearchResult<T>[]>;
    /** Pick up documents written by another process; returns counts. */
    catchUp(): { indexed: number; removed: number };
  }
}

const ftsTable = (coll: string) => `${coll}_fts`;
const col = (i: number) => `f${i}`;
const STATE = "_monlite_fts_state";
// doc_id → fts rowid map, so the per-doc re-index can DELETE by rowid (O(log n))
// instead of scanning the fts table on the UNINDEXED doc_id column (O(n), which
// made bulk ingestion O(n²)).
const IDMAP = "_monlite_fts_ids";

function ensureState(db: Monlite): void {
  db.sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${STATE} (coll TEXT PRIMARY KEY, high_water INTEGER NOT NULL)`,
  );
  db.sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${IDMAP} (coll TEXT NOT NULL, doc_id TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (coll, doc_id))`,
  );
}
function getHighWater(db: Monlite, coll: string): number {
  const row = db.sqlite
    .prepare(`SELECT high_water FROM ${STATE} WHERE coll = ?`)
    .get(coll) as { high_water: number } | undefined;
  return row?.high_water ?? 0;
}
function setHighWater(db: Monlite, coll: string, value: number): void {
  db.sqlite
    .prepare(
      `INSERT INTO ${STATE}(coll, high_water) VALUES (?, ?) ON CONFLICT(coll) DO UPDATE SET high_water = excluded.high_water`,
    )
    .run(coll, value);
}

/**
 * Incrementally index documents written by another process (and drop entries for
 * cross-process deletes), so a separate searcher process becomes fresh without a
 * full {@link reindex}. Returns how many docs were (re)indexed and removed.
 */
export function catchUp(
  db: Monlite,
  coll: string,
  fields: string[],
): { indexed: number; removed: number } {
  const sqlite = db.sqlite;
  ensureState(db);
  const hw = getHighWater(db, coll);
  // `updated_at >= hw` catches recent writes, but a document synced in with an
  // older (past) timestamp sits BELOW the high-water — also index anything missing
  // from the index entirely, so cross-process/past-dated writes don't go unsearchable.
  const docs = sqlite
    .prepare(
      `SELECT _id, updated_at FROM "${coll}" WHERE updated_at >= ? ` +
        `OR _id NOT IN (SELECT doc_id FROM ${IDMAP} WHERE coll = ?)`,
    )
    .all(hw, coll) as Array<{ _id: string; updated_at: number }>;
  let max = hw;
  for (const d of docs) {
    indexDoc(db, coll, fields, d._id);
    if (d.updated_at > max) max = d.updated_at;
  }
  // Remove index rows whose document was deleted (possibly by another process).
  const orphans = sqlite
    .prepare(
      `SELECT rowid AS rid, doc_id FROM "${ftsTable(coll)}" WHERE doc_id NOT IN (SELECT _id FROM "${coll}")`,
    )
    .all() as Array<{ rid: number; doc_id: string }>;
  const del = sqlite.prepare(`DELETE FROM "${ftsTable(coll)}" WHERE rowid = ?`);
  const delMap = sqlite.prepare(
    `DELETE FROM ${IDMAP} WHERE coll = ? AND doc_id = ?`,
  );
  for (const o of orphans) {
    del.run(o.rid);
    delMap.run(coll, o.doc_id);
  }
  setHighWater(db, coll, max);
  return { indexed: docs.length, removed: orphans.length };
}

/** Extract searchable text for a field path from a document. */
function extractText(doc: Record<string, any>, path: string): string {
  let cur: any = doc;
  for (const seg of path.split(".")) {
    if (cur == null) return "";
    cur = cur[seg];
  }
  if (cur == null) return "";
  if (typeof cur === "string") return cur;
  if (Array.isArray(cur))
    return cur
      .filter((x) => x != null)
      .map(String)
      .join(" ");
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return "";
}

function indexDoc(
  db: Monlite,
  coll: string,
  fields: string[],
  id: string,
): void {
  const sqlite = db.sqlite;
  const prev = sqlite
    .prepare(`SELECT rid FROM ${IDMAP} WHERE coll = ? AND doc_id = ?`)
    .get(coll, id) as { rid: number } | undefined;
  if (prev)
    sqlite
      .prepare(`DELETE FROM "${ftsTable(coll)}" WHERE rowid = ?`)
      .run(prev.rid);
  const doc = db.collection(coll).getRaw(id);
  if (!doc) {
    if (prev)
      sqlite
        .prepare(`DELETE FROM ${IDMAP} WHERE coll = ? AND doc_id = ?`)
        .run(coll, id);
    return; // deleted
  }
  const cols = fields.map((_, i) => `"${col(i)}"`).join(", ");
  const placeholders = fields.map(() => "?").join(", ");
  const values = fields.map((f) => extractText(doc, f));
  const res = sqlite
    .prepare(
      `INSERT INTO "${ftsTable(coll)}"(doc_id, ${cols}) VALUES (?, ${placeholders})`,
    )
    .run(id, ...values);
  sqlite
    .prepare(
      `INSERT INTO ${IDMAP}(coll, doc_id, rid) VALUES (?, ?, ?) ON CONFLICT(coll, doc_id) DO UPDATE SET rid = excluded.rid`,
    )
    .run(coll, id, Number(res.lastInsertRowid));
}

/** Rebuild a collection's FTS index from scratch. */
export function reindex(db: Monlite, coll: string, fields: string[]): void {
  const sqlite = db.sqlite;
  sqlite.exec(`DELETE FROM "${ftsTable(coll)}"`);
  sqlite.prepare(`DELETE FROM ${IDMAP} WHERE coll = ?`).run(coll);
  for (const doc of db.collection(coll).findManyCore({})) {
    indexDoc(db, coll, fields, (doc as WithId<Doc>)._id);
  }
}

/**
 * Run an FTS5 MATCH. Untrusted input can contain FTS5 syntax (a stray `"`, a bare
 * `AND`/`*`, column filters) that throws "fts5: syntax error" — so on error, retry
 * with the text quoted as literal phrase tokens. Never throws on user input.
 */
function ftsMatch(
  db: Monlite,
  coll: string,
  query: string,
  fetch: number,
): Array<{ doc_id: string; rank: number }> {
  const sql =
    `SELECT doc_id, rank FROM "${ftsTable(coll)}" ` +
    `WHERE "${ftsTable(coll)}" MATCH ? ORDER BY rank LIMIT ?`;
  const run = (q: string) =>
    db.sqlite.prepare(sql).all(q, fetch) as Array<{
      doc_id: string;
      rank: number;
    }>;
  try {
    return run(query);
  } catch {
    const safe = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" ");
    if (!safe) return [];
    try {
      return run(safe);
    } catch {
      return [];
    }
  }
}

function search<T = Doc>(
  db: Monlite,
  coll: Collection<T>,
  spec: FtsSpec,
  query: string,
  opts?: SearchOptions<T>,
): Promise<SearchResult<T>[]> {
  const fields = spec[coll.name];
  if (!fields) {
    throw new Error(
      `Collection "${coll.name}" is not configured for full-text search`,
    );
  }
  const limit = opts?.limit ?? 50;
  // With a where filter, over-fetch ranked matches then filter + trim to limit,
  // so a selective filter doesn't drop results that exist further down the rank.
  // Cap the pool so the `_id IN (...)` filter can't exceed SQLite's variable limit.
  const fetch = opts?.where
    ? Math.min(Math.max(opts.candidates ?? limit * 10, 200), 10_000)
    : limit;
  const rows = ftsMatch(db, coll.name, query, fetch);

  let allowed: Set<string> | null = null;
  if (opts?.where) {
    const ids = rows.map((r) => r.doc_id);
    const idIn = { _id: { in: ids } } as WhereInput<T>;
    const matching = coll.findManyCore({
      where: { AND: [opts.where, idIn] } as WhereInput<T>,
    });
    allowed = new Set(matching.map((d) => d._id));
  }

  const out: SearchResult<T>[] = [];
  for (const r of rows) {
    if (out.length >= limit) break; // check BEFORE pushing (limit:0 → 0 results)
    if (allowed && !allowed.has(r.doc_id)) continue;
    const doc = coll.getRaw(r.doc_id);
    if (doc) out.push({ ...doc, _score: -r.rank } as SearchResult<T>);
  }
  return Promise.resolve(out);
}

/**
 * Full-text search plugin (SQLite FTS5). Pass it to `createDb({ plugins: [...] })`
 * with a map of collection → searchable fields. Adds `collection.search()`, keeps
 * the index in sync on every write, and backfills existing documents on open.
 *
 * ```ts
 * const db = createDb("./app.db", { plugins: [fts({ posts: ["title", "body"] })] });
 * await db.collection("posts").search("hello world");
 * ```
 */
export function fts(spec: FtsSpec): MonlitePlugin {
  let database: Monlite;
  return {
    name: "fts",
    init(db) {
      database = db;
      ensureState(db);
      for (const [coll, fields] of Object.entries(spec)) {
        const cols = fields.map((_, i) => `"${col(i)}"`).join(", ");
        db.sqlite.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS "${ftsTable(coll)}" ` +
            `USING fts5(doc_id UNINDEXED, ${cols})`,
        );
        // Migration: backfill the doc_id→rowid map for any existing fts rows
        // (databases written before the map existed), so re-index deletes hit
        // the right row instead of leaving duplicates.
        db.sqlite
          .prepare(
            `INSERT OR IGNORE INTO ${IDMAP}(coll, doc_id, rid) SELECT ?, doc_id, rowid FROM "${ftsTable(coll)}"`,
          )
          .run(coll);
        // Backfill when the index is empty (e.g. enabling FTS on an existing db).
        const count = db.sqlite
          .prepare(`SELECT count(*) AS n FROM "${ftsTable(coll)}"`)
          .get() as { n: number };
        if (count.n === 0) reindex(db, coll, fields);
        // Pick up anything other processes wrote since we last indexed.
        catchUp(db, coll, fields);
      }
    },
    afterWrite(db, { collection, ids }) {
      const fields = spec[collection];
      if (!fields) return;
      for (const id of ids) indexDoc(db, collection, fields, id);
      setHighWater(db, collection, Date.now()); // our index is current to now
    },
    collectionMethods: {
      search: (collection, query: string, opts?: SearchOptions) =>
        search(database, collection, spec, query, opts),
      catchUp: (collection) =>
        catchUp(database, collection.name, spec[collection.name] ?? []),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Dynamic search index (programmatic, not document-bound)
//
// The `fts()` plugin attaches `collection.search()` to a DOCUMENT collection with
// a STATIC spec. When you instead need a programmatic full-text index over
// collections created at RUNTIME — RAG corpora, per-tenant indexes — use
// `createSearchIndex(db)`. Each collection is its own FTS5 table; `fields` are
// indexed for search and `filterFields` are stored UNINDEXED so a `where` scopes
// the MATCH (e.g. keyword search within one case/tenant). Synchronous.
// ────────────────────────────────────────────────────────────────────────────

const FTS_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ftsIdent(name: string): string {
  if (!FTS_IDENT.test(name))
    throw new Error(`@monlite/fts: unsafe collection/field name "${name}"`);
  return name;
}

export interface SearchIndexOptions {
  /** Text fields indexed for full-text search. */
  fields: string[];
  /** Fields stored UNINDEXED, for exact `where` filtering (scoped search). Default `[]`. */
  filterFields?: string[];
}

export interface SearchIndexPoint {
  id: string;
  /** Indexed text, keyed by field name (the configured `fields`). */
  fields: Record<string, string>;
  /** Filter values, keyed by field name (the configured `filterFields`). */
  filters?: Record<string, string>;
}

export interface SearchIndexHit {
  id: string;
  /** Relevance (higher = better; derived from BM25 rank). */
  score: number;
}

export interface SearchIndex {
  ensureCollection(name: string, opts: SearchIndexOptions): void;
  upsert(name: string, points: SearchIndexPoint[]): void;
  search(
    name: string,
    query: string,
    opts?: { limit?: number; where?: Record<string, string> },
  ): SearchIndexHit[];
  delete(
    name: string,
    opts: { id?: string; where?: Record<string, string> },
  ): void;
}

/**
 * A programmatic, dynamic full-text index over `@monlite/core` (SQLite FTS5) —
 * collections created at runtime, with optional scoped filtering.
 *
 * ```ts
 * const idx = createSearchIndex(db);
 * idx.ensureCollection("docs", { fields: ["title", "body"], filterFields: ["docId"] });
 * idx.upsert("docs", [{ id: "c1", fields: { title, body }, filters: { docId: "d1" } }]);
 * idx.search("docs", "hello world", { where: { docId: "d1" }, limit: 10 }); // scoped
 * ```
 */
export function createSearchIndex(db: Monlite): SearchIndex {
  const configs = new Map<
    string,
    { fields: string[]; filterFields: string[] }
  >();

  const create = (name: string, fields: string[], filterFields: string[]) => {
    const n = ftsIdent(name);
    const fcols = fields.map(ftsIdent).join(", ");
    const ucols = filterFields
      .map((f) => `, ${ftsIdent(f)} UNINDEXED`)
      .join("");
    db.sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${n}" USING fts5(doc_id UNINDEXED, ${fcols}${ucols})`,
    );
    configs.set(name, { fields, filterFields });
    return configs.get(name)!;
  };

  const known = (name: string) => {
    if (configs.has(name)) return configs.get(name)!;
    const row = db.sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) as { sql?: string } | undefined;
    if (!row?.sql) return undefined;
    // Recover the REAL schema from the fts5 table definition so a reopened index
    // can index/search correctly. Caching empty fields here silently made every
    // later upsert insert an unsearchable row. doc_id is skipped; UNINDEXED columns
    // are filterFields, the rest are searchable fields.
    const cols = row.sql.match(/fts5\s*\(([\s\S]*)\)/i);
    const fields: string[] = [];
    const filterFields: string[] = [];
    if (cols) {
      for (const raw of cols[1].split(",")) {
        const part = raw.trim();
        const unindexed = /\bUNINDEXED\b/i.test(part);
        const colName = part
          .replace(/\bUNINDEXED\b/i, "")
          .trim()
          .replace(/^"(.*)"$/, "$1");
        if (!colName || colName === "doc_id") continue;
        (unindexed ? filterFields : fields).push(colName);
      }
    }
    configs.set(name, { fields, filterFields });
    return configs.get(name)!;
  };

  return {
    ensureCollection(name, { fields, filterFields = [] }) {
      if (!configs.has(name)) create(name, fields, filterFields);
    },

    upsert(name, points) {
      if (!points?.length) return;
      const cfg = configs.get(name);
      if (!cfg)
        throw new Error(
          `@monlite/fts: ensureCollection("${name}") before upsert`,
        );
      const cols = [...cfg.fields, ...cfg.filterFields];
      const colList = cols.map((c) => `, ${c}`).join("");
      const ph = cols.map(() => ", ?").join("");
      const del = db.sqlite.prepare(`DELETE FROM "${name}" WHERE doc_id = ?`);
      const ins = db.sqlite.prepare(
        `INSERT INTO "${name}"(doc_id${colList}) VALUES (?${ph})`,
      );
      db.sqlite.exec("BEGIN");
      try {
        for (const p of points) {
          del.run(p.id);
          const vals = [
            ...cfg.fields.map((f) => p.fields?.[f] ?? ""),
            ...cfg.filterFields.map((f) => p.filters?.[f] ?? ""),
          ];
          ins.run(p.id, ...vals);
        }
        db.sqlite.exec("COMMIT");
      } catch (err) {
        try {
          db.sqlite.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    },

    search(name, query, opts = {}) {
      const cfg = known(name);
      if (!cfg) return [];
      const limit = opts.limit ?? 50;
      const where = Object.entries(opts.where ?? {}).filter(
        ([, v]) => v != null,
      );
      const clause = where.map(([k]) => ` AND ${ftsIdent(k)} = ?`).join("");
      const sql =
        `SELECT doc_id, rank FROM "${name}" ` +
        `WHERE "${name}" MATCH ?${clause} ORDER BY rank LIMIT ?`;
      let rows: Array<{ doc_id: string; rank: number }>;
      try {
        rows = db.sqlite
          .prepare(sql)
          .all(query, ...where.map(([, v]) => v), limit) as never;
      } catch {
        return [];
      }
      return rows.map((r) => ({ id: r.doc_id, score: -r.rank }));
    },

    delete(name, { id, where }) {
      const cfg = known(name);
      if (!cfg) return;
      if (id != null) {
        db.sqlite.prepare(`DELETE FROM "${name}" WHERE doc_id = ?`).run(id);
        return;
      }
      const pairs = Object.entries(where ?? {}).filter(([, v]) => v != null);
      if (!pairs.length) return;
      const clause = pairs.map(([k]) => `${ftsIdent(k)} = ?`).join(" AND ");
      db.sqlite
        .prepare(`DELETE FROM "${name}" WHERE ${clause}`)
        .run(...pairs.map(([, v]) => v));
    },
  };
}
