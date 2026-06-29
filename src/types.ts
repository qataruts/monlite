/**
 * Public type surface for monlite.
 *
 * Documents are plain objects. monlite adds three system fields to every
 * stored document: `_id`, `created_at`, and `updated_at`.
 */

import type { MonlitePlugin } from "./plugin.js";
import type { Driver, AsyncDriver } from "./driver/types.js";

/** A free-form document. */
export type Doc = Record<string, any>;

/** System fields monlite manages on every document. */
export interface SystemFields {
  _id: string;
  /** Unix epoch milliseconds. */
  created_at: number;
  /** Unix epoch milliseconds. */
  updated_at: number;
}

/** A stored document: the user's shape plus monlite's system fields. */
export type WithId<T> = T & SystemFields;

/* ------------------------------------------------------------------ *
 * Collection configuration (document vs structured)
 * ------------------------------------------------------------------ */

/** SQLite column affinity for a structured-collection field. */
export type ColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB" | "JSON";

/** Rich column definition for a structured collection. */
export interface ColumnDef {
  type: ColumnType;
  /** Create a secondary index on this column. */
  index?: boolean;
  unique?: boolean;
  notNull?: boolean;
  /** Default value (string/number literal, or null). */
  default?: string | number | null;
  /** Foreign-key target, e.g. `"users(_id)"` or `"users"`. */
  references?: string;
}

/** Map of field name to column type (or full definition). */
export type CollectionSchema = Record<string, ColumnType | ColumnDef>;

export interface CollectionOptions {
  /**
   * Declare native SQL columns ("structured" mode). Listed fields become real
   * typed columns — fast, indexable, joinable — and any other fields overflow
   * into a JSON column. Omit for schema-free document mode. The CRUD/query API
   * is identical either way.
   */
  schema?: CollectionSchema;
  /**
   * Compound unique indexes — each inner array is a set of fields that must be
   * unique together (e.g. `[["tenantId", "jobId", "key"]]`). A duplicate throws
   * `MonliteUniqueConstraintError`. Fields may be declared columns or JSON paths.
   */
  uniqueIndexes?: string[][];
  /**
   * Time-to-live for documents. `field` is a timestamp (epoch ms) — typically
   * `"created_at"`; rows older than `seconds` are removed by `purgeExpired()`.
   */
  ttl?: { field: string; seconds: number };
}

export type CollectionMode = "document" | "structured";

/** Options for {@link Collection.$migrate}. */
export interface MigrateOptions {
  /** Rename existing physical columns: `{ oldName: newDeclaredName }`. */
  rename?: Record<string, string>;
  /** Acknowledge physical columns to drop (not present in the new schema). */
  drop?: string[];
}

/** A column as reported by {@link Monlite.$schema}. */
export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

/* ------------------------------------------------------------------ *
 * Reactivity
 * ------------------------------------------------------------------ */

/** An update delivered to a `watch()` subscriber. */
export interface LiveEvent<T = Doc> {
  /** `"init"` is the first delivery; `"change"` for every update after. */
  type: "init" | "change";
  /** The full current result set. */
  results: WithId<T>[];
  /** Documents that entered the result set since the last event. */
  added: WithId<T>[];
  /** Documents that left the result set. */
  removed: WithId<T>[];
  /** Documents still in the set whose contents changed. */
  changed: WithId<T>[];
  /**
   * Documents still in the set whose POSITION changed (only for an ordered
   * query — `orderBy`). Empty/absent otherwise.
   */
  moved?: WithId<T>[];
  /**
   * For each `changed` document (keyed by `_id`), the field names that actually
   * changed value (system fields `created_at`/`updated_at` excluded).
   */
  changedFields?: Record<string, string[]>;
}

/** Handle returned by `collection.watch()`. */
export interface WatchHandle<T = Doc> {
  /** The current result set (kept up to date). */
  readonly results: WithId<T>[];
  /** Stop receiving updates. */
  stop(): void;
}

/** Args for `collection.watch()` — a `findMany` query plus reactive options. */
export interface WatchArgs<T = Doc> extends FindManyArgs<T> {
  /**
   * Only emit a `"change"` event when one of these fields actually changes.
   * Documents entering (`added`) or leaving (`removed`) the set, and position
   * changes (`moved`), still always fire. Omit to fire on any change.
   */
  fields?: (keyof T | (string & {}))[];
}

/**
 * One entry in the ordered, durable change feed (see {@link Monlite.changes}).
 * Requires `{ changefeed: true }` (or `{ sync: true }`) at `createDb`.
 */
export interface ChangeEvent {
  /** Monotonic cursor — pass back as `since` to resume exactly after this event. */
  seq: number;
  /** Collection the change belongs to. */
  collection: string;
  /** Document id. */
  id: string;
  /** `"upsert"` (create/update) or `"delete"`. */
  op: "upsert" | "delete";
  /** Wall-clock millis when the change was recorded. */
  ts: number;
}

/** Options for {@link Monlite.changes}. */
export interface ChangesOptions {
  /** Resume strictly after this `seq` (default `0` = from the start of the feed). */
  since?: number;
  /** Poll interval in ms for picking up cross-process writes. Default `200`. */
  pollMs?: number;
  /** Stop the stream when aborted. */
  signal?: AbortSignal;
}

/** Result of `collection.explain()`. */
export interface ExplainResult {
  sql: string;
  /** Whether SQLite's planner uses an index (vs a full scan). */
  usesIndex: boolean;
  /** Raw EXPLAIN QUERY PLAN rows. */
  plan: Array<{ id: number; parent: number; detail: string }>;
}

/* ------------------------------------------------------------------ *
 * Where clause
 * ------------------------------------------------------------------ */

/** Per-field operators, Prisma-style (no `$` prefix). */
export interface FieldFilter<V = any> {
  equals?: V | null;
  not?: V | null;
  in?: V[];
  notIn?: V[];
  lt?: V;
  lte?: V;
  gt?: V;
  gte?: V;
  /** Substring match on strings, or element membership on arrays. */
  contains?: V extends string ? string : any;
  startsWith?: string;
  endsWith?: string;
  /** JavaScript-`RegExp` match — a pattern string or a `RegExp`. Pair a string
   * with `mode: "insensitive"` for the `i` flag. */
  regex?: string | RegExp;
  /** Explicit array element membership. */
  has?: any;
  /**
   * Match if **any** array element satisfies a sub-filter (Mongo `$elemMatch`).
   * Scalars: `{ elemMatch: { gte: 3 } }`; objects: `{ elemMatch: { name: "x" } }`.
   */
  elemMatch?: any;
  /** Field presence. `true` requires the field to exist, `false` requires absence. */
  exists?: boolean;
  /**
   * Case sensitivity for `contains`/`startsWith`/`endsWith`. Default is
   * case-sensitive; `"insensitive"` matches case-insensitively (ASCII).
   */
  mode?: "default" | "insensitive";
}

/** A value used directly as a filter is shorthand for `{ equals: value }`. */
export type FilterInput<V> = V | FieldFilter<V>;

/** A dot-notation nested path, e.g. `"address.city"`. */
export type DotPath = `${string}.${string}`;

/**
 * Where input. For a **typed** collection, keys are checked against `T` (an
 * unknown field is a type error); dot-notation nested paths are still allowed.
 * For an **untyped** collection (`Doc`), any field is accepted (schema-free).
 */
export type WhereInput<T = Doc> = {
  [K in keyof T]?: FilterInput<T[K]>;
} & {
  _id?: FilterInput<string>;
  created_at?: FilterInput<number>;
  updated_at?: FilterInput<number>;
  AND?: WhereInput<T> | WhereInput<T>[];
  OR?: WhereInput<T> | WhereInput<T>[];
  NOT?: WhereInput<T> | WhereInput<T>[];
} & {
  // Nested dot-paths stay open; plain unknown fields are rejected (when typed).
  [path: DotPath]: FilterInput<any>;
};

/* ------------------------------------------------------------------ *
 * Update data
 * ------------------------------------------------------------------ */

/** Mongo-inspired update operators. */
export interface UpdateOperators {
  $set?: Record<string, any>;
  $unset?: Record<string, true | 1>;
  $inc?: Record<string, number>;
  $push?: Record<string, any>;
  /** Append to an array only if the value isn't already present. Supports `$each`. */
  $addToSet?: Record<string, any>;
  $pull?: Record<string, any>;
}

/**
 * Update payload. Either a plain object (shallow-merged into the document)
 * or an object using update operators. The two forms cannot be mixed.
 */
export type UpdateData<T = Doc> =
  | (Partial<T> & Record<string, any>)
  | UpdateOperators;

/* ------------------------------------------------------------------ *
 * Read options
 * ------------------------------------------------------------------ */

export type SortOrder = "asc" | "desc";

export type OrderBy<T = Doc> =
  | ({ [K in keyof WithId<T>]?: SortOrder } & { [path: DotPath]: SortOrder })
  | Array<
      { [K in keyof WithId<T>]?: SortOrder } & { [path: DotPath]: SortOrder }
    >;

export type Select<T = Doc> = { [K in keyof WithId<T>]?: boolean } & {
  [path: DotPath]: boolean;
};

/* ------------------------------------------------------------------ *
 * Select-narrowed result types
 * ------------------------------------------------------------------ */

/** True for the schema-free `Doc` (and `any`), so typed collections opt in only. */
type IsLoose<T> = string extends keyof T ? true : false;

/** Keys of a select set to a truthy value (a widened `boolean` counts as truthy). */
type SelectedKeys<S> = keyof {
  [K in keyof S as S[K] extends false ? never : K]: K;
};

/**
 * The shape `findMany`/`findFirst` return for a given `select`. Untyped (`Doc`)
 * collections and absent/empty selects return the full document; a typed select
 * narrows to exactly the chosen fields.
 */
export type Projected<T, S> =
  IsLoose<T> extends true
    ? WithId<T>
    : [S] extends [undefined]
      ? WithId<T>
      : keyof S extends never
        ? WithId<T>
        : Pick<WithId<T>, Extract<SelectedKeys<S>, keyof WithId<T>>>;

/**
 * A `$lookup`-style left join: for each result, fetch matching documents from
 * another collection and attach them. With `unwind`, emit one row per match
 * (`$unwind`); `unwind: "preserve"` also keeps rows that have no match.
 */
export interface LookupSpec {
  /** The collection to join. */
  from: string;
  /** Field on this collection to match on. */
  localField: string;
  /** Field on the `from` collection to match against. */
  foreignField: string;
  /** Output field that receives the matched document(s). */
  as: string;
  /** Flatten the `as` array to a single object (one output row per match). */
  unwind?: boolean | "preserve";
}

export interface FindManyArgs<T = Doc> {
  where?: WhereInput<T>;
  orderBy?: OrderBy<T>;
  select?: Select<T>;
  skip?: number;
  take?: number;
  /** Join related documents from other collections ($lookup / $unwind). */
  lookup?: LookupSpec | LookupSpec[];
}

export interface FindFirstArgs<T = Doc> {
  where?: WhereInput<T>;
  orderBy?: OrderBy<T>;
  select?: Select<T>;
  skip?: number;
  lookup?: LookupSpec | LookupSpec[];
}

export interface CreateArgs<T = Doc> {
  data: Partial<T> & Record<string, any>;
}

export interface CreateManyArgs<T = Doc> {
  data: Array<Partial<T> & Record<string, any>>;
}

export interface UpdateArgs<T = Doc> {
  where: WhereInput<T>;
  data: UpdateData<T>;
}

export interface UpsertArgs<T = Doc> {
  where: WhereInput<T>;
  create: Partial<T> & Record<string, any>;
  update: UpdateData<T>;
}

export interface DeleteArgs<T = Doc> {
  where: WhereInput<T>;
}

/** Atomically update the first matching document and return it. */
export interface FindOneAndUpdateArgs<T = Doc> {
  where: WhereInput<T>;
  data: UpdateData<T>;
  /** Return the document `"before"` or `"after"` the update. Default `"after"`. */
  returnDocument?: "before" | "after";
}

/** A single operation in a {@link Collection.bulkWrite} batch. */
export type BulkWriteOp<T = Doc> =
  | { insertOne: Partial<T> & Record<string, any> }
  | { updateOne: { where: WhereInput<T>; data: UpdateData<T> } }
  | { updateMany: { where: WhereInput<T>; data: UpdateData<T> } }
  | { deleteOne: { where: WhereInput<T> } }
  | { deleteMany: { where: WhereInput<T> } };

export interface BulkWriteResult {
  inserted: number;
  updated: number;
  deleted: number;
}

export interface CountArgs<T = Doc> {
  where?: WhereInput<T>;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

/** Map of `field -> true` selecting which fields an accumulator applies to. */
export type FieldSelection = Record<string, boolean>;

export interface AggregateArgs<T = Doc> {
  where?: WhereInput<T>;
  _count?: boolean;
  _sum?: FieldSelection;
  _avg?: FieldSelection;
  _min?: FieldSelection;
  _max?: FieldSelection;
}

export interface AggregateResult {
  _count?: number;
  _sum?: Record<string, number | null>;
  _avg?: Record<string, number | null>;
  _min?: Record<string, any>;
  _max?: Record<string, any>;
}

/** Numeric comparison used by `groupBy` having-filters. */
export interface HavingComparison {
  equals?: number;
  not?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

/** Post-aggregation filter (SQL `HAVING`) for `groupBy`. */
export interface HavingInput {
  _count?: HavingComparison;
  _sum?: Record<string, HavingComparison>;
  _avg?: Record<string, HavingComparison>;
  _min?: Record<string, HavingComparison>;
  _max?: Record<string, HavingComparison>;
}

export interface GroupByArgs<T = Doc> {
  by: string[];
  where?: WhereInput<T>;
  having?: HavingInput;
  _count?: boolean;
  _sum?: FieldSelection;
  _avg?: FieldSelection;
  _min?: FieldSelection;
  _max?: FieldSelection;
  orderBy?: Record<string, SortOrder>;
  skip?: number;
  take?: number;
}

export type GroupByResult = Record<string, any>;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export type DriverName = "auto" | "better-sqlite3" | "node:sqlite";

/** Encryption-at-rest configuration (requires `better-sqlite3-multiple-ciphers`). */
export interface EncryptionOptions {
  /** The passphrase used to encrypt/decrypt the database file. */
  key: string;
  /**
   * Cipher scheme to use (e.g. `"sqlcipher"`, `"chacha20"`, `"aes256cbc"`).
   * Defaults to the library default (ChaCha20-Poly1305).
   */
  cipher?: string;
}

export interface MonliteOptions {
  /**
   * Which SQLite backend to use. `"auto"` (default) prefers `better-sqlite3`
   * when installed, otherwise the built-in `node:sqlite` (Node >= 22.5).
   * You can also pass a custom {@link Driver} instance (e.g. `@monlite/wasm`
   * for the browser).
   */
  driver?: DriverName | Driver | AsyncDriver;
  /**
   * Encrypt the database at rest. Requires the `better-sqlite3-multiple-ciphers`
   * package (a drop-in for `better-sqlite3`); not supported on `node:sqlite`.
   * Use `db.rekey(newKey)` to rotate the key.
   */
  encryption?: EncryptionOptions;
  /** Opt-in plugins (e.g. `@monlite/fts`). */
  plugins?: MonlitePlugin[];
  /**
   * Enable sync metadata (change feed, tombstones, version tracking) so the
   * database can replicate via `@monlite/sync`. Off by default — adds zero
   * overhead when disabled.
   */
  sync?: boolean;
  /**
   * Record an ordered, durable change feed for {@link Monlite.changes} (realtime
   * / cross-process reactivity) WITHOUT enabling sync. `{ sync: true }` implies
   * this. Off by default — adds one append per write when on.
   */
  changefeed?: boolean;
  /**
   * How often (ms) to poll the change feed so `watch()` picks up writes from
   * OTHER processes sharing this `.db`. Only used when the change feed is on.
   * Default `200`. Same-process writes notify watchers immediately regardless.
   */
  reactorPollMs?: number;
  /**
   * Stable node identity used for last-write-wins tie-breaking. Auto-generated
   * and persisted in the database on first sync-enabled open if omitted.
   */
  nodeId?: string;
  /** Auto-create indexes on frequently-queried JSON paths. Default `true`. */
  autoIndex?: boolean;
  /** Number of times a path must be queried before an index is created. Default `10`. */
  autoIndexAfter?: number;
  /** Open the database read-only. Default `false`. */
  readonly?: boolean;
  /** Use SQLite WAL journal mode for better concurrency. Default `true`. */
  wal?: boolean;
  /** Milliseconds to wait on a locked database before erroring. Default `5000`. */
  busyTimeout?: number;
  /**
   * SQLite `synchronous` mode — durability vs speed. WAL's default is `NORMAL`
   * (safe from app crashes); use `FULL` for maximum power-loss durability, or
   * `OFF` for speed at the risk of corruption on power loss.
   */
  synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
  /** Allow loading SQLite extensions (required by `@monlite/vector`). Default `false`. */
  allowExtensions?: boolean;
  /** Verbose logger for executed SQL (debugging). */
  verbose?: (sql: string) => void;
  /**
   * Observability hook called after each statement runs, with its timing —
   * wire a slow-query log or metrics here (filter by `durationMs`). Only adds
   * overhead when provided.
   */
  onQuery?: (event: { sql: string; durationMs: number }) => void;
  /**
   * Reject writes whose serialized document exceeds this many bytes. A guard
   * against unbounded/untrusted input (multi-tenant or public-facing use).
   * Off by default.
   */
  maxDocumentBytes?: number;
  /**
   * Cap the rows an unbounded `findMany` (no `take`) may return — it throws past
   * this instead of materializing an unbounded result set. Off by default;
   * internal queries (indexing/reactivity) are never capped.
   */
  maxRows?: number;
}

/** Database statistics from {@link Monlite.stats}. */
export interface DbStats {
  /** On-disk size in bytes (`page_size * page_count`). */
  sizeBytes: number;
  pageSize: number;
  pageCount: number;
  /** Number of monlite collections (tables with `_id` + `data`). */
  collections: number;
  /** Number of indexes. */
  indexes: number;
}
