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
  return {
    name: "vector",
    init(db) {
      database = db;
      try {
        db.sqlite.loadExtension(sqliteVec.getLoadablePath());
      } catch (err) {
        throw new Error(
          `@monlite/vector: failed to load sqlite-vec. Open the database with ` +
            `{ allowExtensions: true }. (${(err as Error).message})`,
        );
      }
      for (const [coll, def] of Object.entries(spec)) {
        const metric =
          def.distance === "cosine" ? " distance_metric=cosine" : "";
        db.sqlite.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS "${vecTable(coll)}" ` +
            `USING vec0(doc_id text, embedding float[${def.dimensions}]${metric})`,
        );
        const count = db.sqlite
          .prepare(`SELECT count(*) AS n FROM "${vecTable(coll)}"`)
          .get() as { n: number };
        if (count.n === 0) reindex(db, coll, def);
      }
    },
    afterWrite(db, { collection, ids }) {
      const def = spec[collection];
      if (!def) return;
      for (const id of ids) indexDoc(db, collection, def, id);
    },
    collectionMethods: {
      findSimilar: (coll, opts: FindSimilarOptions) =>
        findSimilar(database, coll, spec, opts),
    },
  };
}
