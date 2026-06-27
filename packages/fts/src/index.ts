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

function ensureState(db: Monlite): void {
  db.sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${STATE} (coll TEXT PRIMARY KEY, high_water INTEGER NOT NULL)`,
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
  const docs = sqlite
    .prepare(`SELECT _id, updated_at FROM "${coll}" WHERE updated_at >= ?`)
    .all(hw) as Array<{ _id: string; updated_at: number }>;
  let max = hw;
  for (const d of docs) {
    indexDoc(db, coll, fields, d._id);
    if (d.updated_at > max) max = d.updated_at;
  }
  // Remove index rows whose document was deleted (possibly by another process).
  const orphans = sqlite
    .prepare(
      `SELECT doc_id FROM "${ftsTable(coll)}" WHERE doc_id NOT IN (SELECT _id FROM "${coll}")`,
    )
    .all() as Array<{ doc_id: string }>;
  const del = sqlite.prepare(
    `DELETE FROM "${ftsTable(coll)}" WHERE doc_id = ?`,
  );
  for (const o of orphans) del.run(o.doc_id);
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
  sqlite.prepare(`DELETE FROM "${ftsTable(coll)}" WHERE doc_id = ?`).run(id);
  const doc = db.collection(coll).getRaw(id);
  if (!doc) return; // deleted
  const cols = fields.map((_, i) => `"${col(i)}"`).join(", ");
  const placeholders = fields.map(() => "?").join(", ");
  const values = fields.map((f) => extractText(doc, f));
  sqlite
    .prepare(
      `INSERT INTO "${ftsTable(coll)}"(doc_id, ${cols}) VALUES (?, ${placeholders})`,
    )
    .run(id, ...values);
}

/** Rebuild a collection's FTS index from scratch. */
export function reindex(db: Monlite, coll: string, fields: string[]): void {
  const sqlite = db.sqlite;
  sqlite.exec(`DELETE FROM "${ftsTable(coll)}"`);
  for (const doc of db.collection(coll).findManyCore({})) {
    indexDoc(db, coll, fields, (doc as WithId<Doc>)._id);
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
  const rows = db.sqlite
    .prepare(
      `SELECT doc_id, rank FROM "${ftsTable(coll.name)}" ` +
        `WHERE "${ftsTable(coll.name)}" MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as Array<{ doc_id: string; rank: number }>;

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
