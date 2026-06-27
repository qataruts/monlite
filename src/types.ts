/**
 * Public type surface for monlite.
 *
 * Documents are plain objects. monlite adds three system fields to every
 * stored document: `_id`, `created_at`, and `updated_at`.
 */

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
}

export type CollectionMode = "document" | "structured";

/** A column as reported by {@link Monlite.$schema}. */
export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
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
  /** Explicit array element membership. */
  has?: any;
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

/**
 * Where input. Known fields are typed from `T`; nested paths can also be
 * addressed with dot notation (e.g. `"address.city"`).
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
  // Dot-notation nested paths and any other string key.
  [path: string]: any;
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
  | ({ [K in keyof T]?: SortOrder } & { [path: string]: SortOrder })
  | Array<{ [path: string]: SortOrder }>;

export type Select<T = Doc> = { [K in keyof T]?: boolean } & {
  [path: string]: boolean;
};

export interface FindManyArgs<T = Doc> {
  where?: WhereInput<T>;
  orderBy?: OrderBy<T>;
  select?: Select<T>;
  skip?: number;
  take?: number;
}

export interface FindFirstArgs<T = Doc> {
  where?: WhereInput<T>;
  orderBy?: OrderBy<T>;
  select?: Select<T>;
  skip?: number;
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

export interface MonliteOptions {
  /**
   * Which SQLite backend to use. `"auto"` (default) prefers `better-sqlite3`
   * when installed, otherwise the built-in `node:sqlite` (Node >= 22.5).
   */
  driver?: DriverName;
  /**
   * Enable sync metadata (change feed, tombstones, version tracking) so the
   * database can replicate via `@monlite/sync`. Off by default — adds zero
   * overhead when disabled.
   */
  sync?: boolean;
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
  /** Verbose logger for executed SQL (debugging). */
  verbose?: (sql: string) => void;
}
