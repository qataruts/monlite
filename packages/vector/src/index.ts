import type {
  Collection,
  Doc,
  Monlite,
  MonlitePlugin,
  WhereInput,
  WithId,
} from "@monlite/core";
import * as sqliteVec from "sqlite-vec";

/** Per-collection vector config: which field holds the embedding, and its size. */
export interface VectorField {
  /** Document field holding the embedding (a `number[]`). Dot-notation allowed. */
  field: string;
  /** Embedding dimensionality (must match your model). */
  dimensions: number;
  /** Distance metric. Default `"l2"`. */
  distance?: "l2" | "cosine";
}

export type VectorSpec = Record<string, VectorField>;

export interface FindSimilarOptions<T = Doc> {
  /** Query embedding (length must equal the configured `dimensions`). */
  vector: number[];
  /** Number of nearest neighbours to return. Default 10. */
  topK?: number;
  /** Additionally constrain matches with a normal monlite where clause. */
  where?: WhereInput<T>;
}

export type SimilarResult<T = Doc> = WithId<T> & { _distance: number };

// Make `collection.findSimilar()` typed wherever @monlite/vector is imported.
declare module "@monlite/core" {
  interface Collection<T> {
    findSimilar(opts: FindSimilarOptions<T>): Promise<SimilarResult<T>[]>;
    /** Pick up documents written by another process; returns counts. */
    catchUp(): { indexed: number; removed: number };
  }
}

const vecTable = (coll: string) => `${coll}_vec`;

function getEmbedding(
  doc: Record<string, any>,
  field: string,
  dim: number,
): number[] | null {
  let cur: any = doc;
  for (const seg of field.split(".")) {
    if (cur == null) return null;
    cur = cur[seg];
  }
  if (
    Array.isArray(cur) &&
    cur.length === dim &&
    cur.every((x) => typeof x === "number")
  ) {
    return cur;
  }
  return null;
}

function indexDoc(
  db: Monlite,
  coll: string,
  def: VectorField,
  id: string,
): void {
  const sqlite = db.sqlite;
  sqlite.prepare(`DELETE FROM "${vecTable(coll)}" WHERE doc_id = ?`).run(id);
  const doc = db.collection(coll).getRaw(id);
  if (!doc) return;
  const emb = getEmbedding(doc, def.field, def.dimensions);
  if (!emb) return; // no embedding on this document (yet)
  sqlite
    .prepare(`INSERT INTO "${vecTable(coll)}"(doc_id, embedding) VALUES (?, ?)`)
    .run(id, JSON.stringify(emb));
}

/** Rebuild a collection's vector index from scratch. */
export function reindex(db: Monlite, coll: string, def: VectorField): void {
  db.sqlite.exec(`DELETE FROM "${vecTable(coll)}"`);
  for (const doc of db.collection(coll).findManyCore({})) {
    indexDoc(db, coll, def, (doc as WithId<Doc>)._id);
  }
}

const STATE = "_monlite_vec_state";
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
  def: VectorField,
): { indexed: number; removed: number } {
  const sqlite = db.sqlite;
  ensureState(db);
  const hw = getHighWater(db, coll);
  const docs = sqlite
    .prepare(`SELECT _id, updated_at FROM "${coll}" WHERE updated_at >= ?`)
    .all(hw) as Array<{ _id: string; updated_at: number }>;
  let max = hw;
  for (const d of docs) {
    indexDoc(db, coll, def, d._id);
    if (d.updated_at > max) max = d.updated_at;
  }
  const orphans = sqlite
    .prepare(
      `SELECT doc_id FROM "${vecTable(coll)}" WHERE doc_id NOT IN (SELECT _id FROM "${coll}")`,
    )
    .all() as Array<{ doc_id: string }>;
  const del = sqlite.prepare(
    `DELETE FROM "${vecTable(coll)}" WHERE doc_id = ?`,
  );
  for (const o of orphans) del.run(o.doc_id);
  setHighWater(db, coll, max);
  return { indexed: docs.length, removed: orphans.length };
}

function findSimilar<T = Doc>(
  db: Monlite,
  coll: Collection<T>,
  spec: VectorSpec,
  opts: FindSimilarOptions<T>,
): Promise<SimilarResult<T>[]> {
  const def = spec[coll.name];
  if (!def) {
    return Promise.reject(
      new Error(
        `Collection "${coll.name}" is not configured for vector search`,
      ),
    );
  }
  if (!Array.isArray(opts.vector) || opts.vector.length !== def.dimensions) {
    return Promise.reject(
      new Error(
        `findSimilar expects a ${def.dimensions}-dimension vector for "${coll.name}"`,
      ),
    );
  }
  const topK = opts.topK ?? 10;
  const rows = db.sqlite
    .prepare(
      `SELECT doc_id, distance FROM "${vecTable(coll.name)}" ` +
        `WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    )
    .all(JSON.stringify(opts.vector), topK) as Array<{
    doc_id: string;
    distance: number;
  }>;

  let allowed: Set<string> | null = null;
  if (opts.where) {
    const ids = rows.map((r) => r.doc_id);
    const idIn = { _id: { in: ids } } as WhereInput<T>;
    const matching = coll.findManyCore({
      where: { AND: [opts.where, idIn] } as WhereInput<T>,
    });
    allowed = new Set(matching.map((d) => d._id));
  }

  const out: SimilarResult<T>[] = [];
  for (const r of rows) {
    if (allowed && !allowed.has(r.doc_id)) continue;
    const doc = coll.getRaw(r.doc_id);
    if (doc) out.push({ ...doc, _distance: r.distance } as SimilarResult<T>);
  }
  return Promise.resolve(out);
}

// ── Brute-force fallback (no sqlite-vec / browser) ──────────────────────────
// When the native sqlite-vec extension can't be loaded (e.g. the SQLite-WASM
// build in the browser), embeddings are stored as JSON in a plain table and the
// nearest neighbours are computed in JS. Exact (not approximate), O(n) per query
// — fine for the thousands-of-vectors scale a local/edge store typically holds.

function l2Distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

function findSimilarBrute<T = Doc>(
  db: Monlite,
  coll: Collection<T>,
  spec: VectorSpec,
  opts: FindSimilarOptions<T>,
): Promise<SimilarResult<T>[]> {
  const def = spec[coll.name];
  if (!def) {
    return Promise.reject(
      new Error(`Collection "${coll.name}" is not configured for vector search`),
    );
  }
  if (!Array.isArray(opts.vector) || opts.vector.length !== def.dimensions) {
    return Promise.reject(
      new Error(
        `findSimilar expects a ${def.dimensions}-dimension vector for "${coll.name}"`,
      ),
    );
  }
  const topK = opts.topK ?? 10;
  const dist = def.distance === "cosine" ? cosineDistance : l2Distance;

  let allowed: Set<string> | null = null;
  if (opts.where) {
    const matching = coll.findManyCore({ where: opts.where });
    allowed = new Set(matching.map((d) => d._id));
  }

  const rows = db.sqlite
    .prepare(`SELECT doc_id, embedding FROM "${vecTable(coll.name)}"`)
    .all() as Array<{ doc_id: string; embedding: string }>;

  const scored: Array<{ doc_id: string; distance: number }> = [];
  for (const r of rows) {
    if (allowed && !allowed.has(r.doc_id)) continue;
    scored.push({
      doc_id: r.doc_id,
      distance: dist(opts.vector, JSON.parse(r.embedding) as number[]),
    });
  }
  scored.sort((a, b) => a.distance - b.distance);

  const out: SimilarResult<T>[] = [];
  for (const r of scored.slice(0, topK)) {
    const doc = coll.getRaw(r.doc_id);
    if (doc) out.push({ ...doc, _distance: r.distance } as SimilarResult<T>);
  }
  return Promise.resolve(out);
}

/**
 * Vector / semantic search plugin (sqlite-vec). Open the database with
 * `{ allowExtensions: true }` and pass this plugin with a map of collection →
 * `{ field, dimensions }`. Adds `collection.findSimilar({ vector, topK, where })`,
 * keeps the index current on writes, and backfills on open.
 *
 * ```ts
 * const db = createDb("./app.db", {
 *   allowExtensions: true,
 *   plugins: [vector({ docs: { field: "embedding", dimensions: 384 } })],
 * });
 * await db.collection("docs").findSimilar({ vector: queryEmbedding, topK: 5 });
 * ```
 */
export interface HybridOptions<T = Doc> {
  /** Keyword query (uses `@monlite/fts`'s `collection.search`, if active). */
  text: string;
  /** Semantic query embedding. */
  vector: number[];
  /** Final number of results. Default 10. */
  topK?: number;
  /** Constrain both arms with a normal monlite where clause. */
  where?: WhereInput<T>;
  /** Candidates pulled from each arm before fusing. Default `topK * 4`. */
  candidates?: number;
  /** Reciprocal-rank-fusion constant. Default 60. */
  k?: number;
}

export type HybridResult<T = Doc> = WithId<T> & { _rrf: number };

/**
 * Hybrid search: run keyword (FTS) and semantic (vector) retrieval and fuse the
 * two rankings with Reciprocal Rank Fusion. The collection should have both
 * `@monlite/fts` and `@monlite/vector` configured; if FTS isn't active it falls
 * back to vector-only.
 *
 * ```ts
 * await hybridSearch(db.collection("docs"), { text: "black holes", vector: q, topK: 5 });
 * ```
 */
export async function hybridSearch<T = Doc>(
  collection: Collection<T>,
  opts: HybridOptions<T>,
): Promise<HybridResult<T>[]> {
  const topK = opts.topK ?? 10;
  const candidates = opts.candidates ?? topK * 4;
  const k = opts.k ?? 60;

  // Structural reference to @monlite/fts's `search` (kept decoupled from its types).
  const searchable = collection as unknown as {
    search?(
      q: string,
      o?: { limit?: number; where?: WhereInput<T> },
    ): Promise<WithId<T>[]>;
  };
  const [keyword, semantic] = await Promise.all([
    typeof searchable.search === "function"
      ? searchable.search(opts.text, { limit: candidates, where: opts.where })
      : Promise.resolve([] as WithId<T>[]),
    collection.findSimilar({
      vector: opts.vector,
      topK: candidates,
      where: opts.where,
    }),
  ]);

  const scores = new Map<string, number>();
  const docs = new Map<string, WithId<T>>();
  const fuse = (list: WithId<T>[]) => {
    list.forEach((doc, i) => {
      scores.set(doc._id, (scores.get(doc._id) ?? 0) + 1 / (k + i + 1));
      docs.set(doc._id, doc);
    });
  };
  fuse(keyword);
  fuse(semantic);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, rrf]) => ({ ...docs.get(id)!, _rrf: rrf }) as HybridResult<T>);
}

export function vector(spec: VectorSpec): MonlitePlugin {
  let database: Monlite;
  // When sqlite-vec can't be loaded (browser / SQLite-WASM), fall back to a
  // brute-force JS implementation over a plain table.
  let bruteForce = false;
  return {
    name: "vector",
    init(db) {
      database = db;
      try {
        db.sqlite.loadExtension(sqliteVec.getLoadablePath());
      } catch {
        bruteForce = true;
      }
      ensureState(db);
      for (const [coll, def] of Object.entries(spec)) {
        if (bruteForce) {
          db.sqlite.exec(
            `CREATE TABLE IF NOT EXISTS "${vecTable(coll)}" ` +
              `(doc_id TEXT PRIMARY KEY, embedding TEXT NOT NULL)`,
          );
        } else {
          const metric =
            def.distance === "cosine" ? " distance_metric=cosine" : "";
          db.sqlite.exec(
            // `doc_id text primary key` makes the per-doc re-index DELETE O(log n)
            // instead of a full scan of the vector table — keeps bulk ingestion
            // linear at 10K–100K+ vectors (otherwise it's O(n²)).
            `CREATE VIRTUAL TABLE IF NOT EXISTS "${vecTable(coll)}" ` +
              `USING vec0(doc_id text primary key, embedding float[${def.dimensions}]${metric})`,
          );
        }
        const count = db.sqlite
          .prepare(`SELECT count(*) AS n FROM "${vecTable(coll)}"`)
          .get() as { n: number };
        if (count.n === 0) reindex(db, coll, def);
        catchUp(db, coll, def); // pick up other processes' writes
      }
    },
    afterWrite(db, { collection, ids }) {
      const def = spec[collection];
      if (!def) return;
      for (const id of ids) indexDoc(db, collection, def, id);
      setHighWater(db, collection, Date.now());
    },
    collectionMethods: {
      findSimilar: (coll, opts: FindSimilarOptions) =>
        bruteForce
          ? findSimilarBrute(database, coll, spec, opts)
          : findSimilar(database, coll, spec, opts),
      catchUp: (coll) =>
        spec[coll.name]
          ? catchUp(database, coll.name, spec[coll.name])
          : { indexed: 0, removed: 0 },
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Dynamic vector store (programmatic, not document-bound)
//
// The `vector()` plugin indexes an embedding FIELD of an existing document
// collection with a STATIC spec. When you instead need a programmatic store over
// collections created at runtime — RAG corpora, per-tenant indexes, "give me a
// vector table for this id" — use `createVectorStore(db)`. Each collection is its
// own `vec0` table with the chosen `indexedFields` as metadata columns (so a
// `where` is applied INSIDE the KNN — exact pre-filtered recall, e.g. scoped to
// one case/tenant even over a large corpus) and the full metadata in a `+payload`
// auxiliary column. Synchronous (raw SQLite). Requires `allowExtensions: true`.
// ────────────────────────────────────────────────────────────────────────────

export interface VectorStoreCollectionOptions {
  /** Embedding dimensionality (must match your model). */
  dimensions: number;
  /** Distance metric. Default `"cosine"`. */
  metric?: "cosine" | "l2";
  /** Metadata fields to index as filterable columns (exact pre-filtered KNN). Default `[]`. */
  indexedFields?: string[];
}

export interface VectorStorePoint {
  id: string;
  vector: number[];
  /** Arbitrary JSON metadata stored alongside the vector and returned on search. */
  metadata?: Record<string, unknown>;
}

export interface VectorStoreHit {
  id: string;
  /** Raw metric distance (smaller = closer): cosine-distance or L2. */
  distance: number;
  metadata: Record<string, unknown>;
}

export interface VectorSearchOptions {
  vector: number[];
  /** Nearest neighbours to return. Default 10. */
  topK?: number;
  /** Exact metadata filter (`{ field: value }`). Fields declared in `indexedFields`
   *  are pushed into the KNN (pre-filtered); others are matched after. */
  where?: Record<string, unknown>;
}

export interface VectorStore {
  ensureCollection(name: string, opts: VectorStoreCollectionOptions): void;
  upsert(name: string, points: VectorStorePoint[]): void;
  search(name: string, opts: VectorSearchOptions): VectorStoreHit[];
  delete(
    name: string,
    opts: { id?: string; where?: Record<string, unknown> },
  ): void;
}

const VEC_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const vecLoaded = new WeakSet<Monlite>();

function loadVec(db: Monlite): void {
  if (vecLoaded.has(db)) return;
  try {
    db.sqlite.loadExtension(sqliteVec.getLoadablePath());
  } catch (err) {
    // The plugin may have already loaded it — verify before failing.
    try {
      db.sqlite.prepare("SELECT vec_version()").get();
    } catch {
      throw new Error(
        `@monlite/vector: createVectorStore needs the database opened with ` +
          `{ allowExtensions: true }. (${(err as Error).message})`,
      );
    }
  }
  vecLoaded.add(db);
}

function vecIdent(name: string): string {
  if (!VEC_IDENT.test(name))
    throw new Error(`@monlite/vector: unsafe collection/field name "${name}"`);
  return name;
}

function wherePairs(
  where: Record<string, unknown> | undefined,
): Array<{ key: string; value: unknown }> {
  if (!where) return [];
  return Object.entries(where)
    .filter(([, v]) => v != null)
    .map(([key, value]) => ({ key, value }));
}

/**
 * A programmatic, dynamic vector store over `@monlite/core` + sqlite-vec — collections
 * are created at runtime, points carry arbitrary metadata, and a `where` filters the KNN.
 *
 * ```ts
 * const db = createDb("./rag.db", { allowExtensions: true });
 * const store = createVectorStore(db);
 * store.ensureCollection("docs", { dimensions: 384, indexedFields: ["docId"] });
 * store.upsert("docs", [{ id: "c1", vector: emb, metadata: { docId: "d1", text } }]);
 * store.search("docs", { vector: q, topK: 5, where: { docId: "d1" } }); // scoped, exact
 * ```
 */
export function createVectorStore(db: Monlite): VectorStore {
  loadVec(db);
  const configs = new Map<string, { metaFields: string[] }>();

  const create = (
    name: string,
    dim: number,
    metric: string,
    metaFields: string[],
  ) => {
    const n = vecIdent(name);
    const metricClause = metric === "l2" ? "" : " distance_metric=cosine";
    const metaCols = metaFields.map((f) => `, ${vecIdent(f)} text`).join("");
    db.sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${n}" USING vec0(` +
        `doc_id text primary key, embedding float[${Math.floor(dim)}]${metricClause}${metaCols}, +payload text)`,
    );
    configs.set(name, { metaFields });
    return configs.get(name)!;
  };

  const known = (name: string) => {
    if (configs.has(name)) return configs.get(name)!;
    const row = db.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name);
    if (row) {
      configs.set(name, { metaFields: [] });
      return configs.get(name)!;
    }
    return undefined;
  };

  return {
    ensureCollection(
      name,
      { dimensions, metric = "cosine", indexedFields = [] },
    ) {
      if (!configs.has(name)) create(name, dimensions, metric, indexedFields);
    },

    upsert(name, points) {
      if (!points?.length) return;
      const cfg =
        configs.get(name) ??
        create(name, points[0]!.vector.length, "cosine", []);
      const meta = cfg.metaFields;
      const colList = meta.map((f) => `, ${f}`).join("");
      const ph = meta.map(() => ", ?").join("");
      const del = db.sqlite.prepare(`DELETE FROM "${name}" WHERE doc_id = ?`);
      const ins = db.sqlite.prepare(
        `INSERT INTO "${name}"(doc_id, embedding${colList}, payload) VALUES (?, ?${ph}, ?)`,
      );
      db.sqlite.exec("BEGIN");
      try {
        for (const p of points) {
          del.run(p.id);
          const metaVals = meta.map((f) =>
            p.metadata?.[f] != null ? String(p.metadata[f]) : null,
          );
          ins.run(
            p.id,
            JSON.stringify(p.vector),
            ...metaVals,
            JSON.stringify(p.metadata ?? {}),
          );
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

    search(name, { vector, topK = 10, where }) {
      const cfg = known(name);
      if (!cfg) return [];
      const meta = new Set(cfg.metaFields);
      const pairs = wherePairs(where);
      const sqlF = pairs.filter((p) => meta.has(p.key));
      const postF = pairs.filter((p) => !meta.has(p.key));
      const k = Math.max(1, postF.length ? Math.max(topK * 8, 64) : topK);
      const clause = sqlF.map((p) => ` AND ${p.key} = ?`).join("");
      const sql =
        `SELECT doc_id, distance, payload FROM "${name}" ` +
        `WHERE embedding MATCH ? AND k = ?${clause} ORDER BY distance`;
      let rows: Array<{ doc_id: string; distance: number; payload: string }>;
      try {
        rows = db.sqlite
          .prepare(sql)
          .all(JSON.stringify(vector), k, ...sqlF.map((p) => p.value)) as never;
      } catch {
        return [];
      }
      const out: VectorStoreHit[] = [];
      for (const r of rows) {
        const metadata = JSON.parse(r.payload || "{}");
        if (postF.length && !postF.every((p) => metadata[p.key] === p.value))
          continue;
        out.push({ id: r.doc_id, distance: r.distance, metadata });
        if (out.length >= topK) break;
      }
      return out;
    },

    delete(name, { id, where }) {
      const cfg = known(name);
      if (!cfg) return;
      if (id != null) {
        db.sqlite.prepare(`DELETE FROM "${name}" WHERE doc_id = ?`).run(id);
        return;
      }
      const pairs = wherePairs(where);
      if (!pairs.length) return;
      const meta = new Set(cfg.metaFields);
      if (pairs.every((p) => meta.has(p.key))) {
        const clause = pairs.map((p) => `${p.key} = ?`).join(" AND ");
        db.sqlite
          .prepare(`DELETE FROM "${name}" WHERE ${clause}`)
          .run(...pairs.map((p) => p.value));
      } else {
        const rows = db.sqlite
          .prepare(`SELECT doc_id, payload FROM "${name}"`)
          .all() as Array<{
          doc_id: string;
          payload: string;
        }>;
        const del = db.sqlite.prepare(`DELETE FROM "${name}" WHERE doc_id = ?`);
        for (const r of rows) {
          const m = JSON.parse(r.payload || "{}");
          if (pairs.every((p) => m[p.key] === p.value)) del.run(r.doc_id);
        }
      }
    },
  };
}
