export { createDb, Monlite } from "./db.js";
export { Collection } from "./collection.js";
export {
  MonliteError,
  MonliteQueryError,
  MonliteConstraintError,
  MonliteUniqueConstraintError,
  MonliteNotNullError,
  MonliteForeignKeyError,
  MonliteEncryptionError,
  normalizeDriverError,
} from "./errors.js";
export { objectId, isObjectId } from "./id.js";
// Shared by custom drivers (e.g. @monlite/wasm) to register the `regex` operator's
// backing SQL function on their connection.
export { REGEXP_FN, monliteRegexp } from "./driver/regexp.js";

export type {
  Doc,
  SystemFields,
  WithId,
  ColumnType,
  ColumnDef,
  CollectionSchema,
  CollectionOptions,
  CollectionMode,
  MigrateOptions,
  ColumnInfo,
  LiveEvent,
  WatchHandle,
  ChangeEvent,
  ChangesOptions,
  ExplainResult,
  FieldFilter,
  FilterInput,
  WhereInput,
  UpdateOperators,
  UpdateData,
  SortOrder,
  OrderBy,
  Select,
  FindManyArgs,
  FindFirstArgs,
  LookupSpec,
  Projected,
  DotPath,
  CreateArgs,
  CreateManyArgs,
  UpdateArgs,
  UpsertArgs,
  DeleteArgs,
  FindOneAndUpdateArgs,
  BulkWriteOp,
  BulkWriteResult,
  CountArgs,
  FieldSelection,
  AggregateArgs,
  AggregateResult,
  GroupByArgs,
  GroupByResult,
  HavingComparison,
  HavingInput,
  MonliteOptions,
  EncryptionOptions,
  DbStats,
  DriverName,
} from "./types.js";
export type {
  Driver,
  PreparedStatement,
  RunResult,
  DriverOpenOptions,
} from "./driver/types.js";
export type { MonlitePlugin, PluginChange } from "./plugin.js";

// Sync primitives (used by @monlite/sync; advanced).
export { SyncStore } from "./sync/store.js";
export { makeVersion, compareVersions, versionTs } from "./sync/version.js";
export type {
  SyncOp,
  Version,
  LocalChange,
  RemoteChange,
  ConflictResolver,
  ApplyResult,
  SyncStateRow,
  ConflictRow,
} from "./sync/store.js";

// Convenience aliases.
export type { Monlite as Db } from "./db.js";
export type { WhereInput as WhereClause } from "./types.js";
