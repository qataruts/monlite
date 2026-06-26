export { createDb, Monlite } from "./db.js";
export { Collection } from "./collection.js";
export { MonliteError, MonliteQueryError } from "./errors.js";
export { objectId, isObjectId } from "./id.js";

export type {
  Doc,
  SystemFields,
  WithId,
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
  CreateArgs,
  CreateManyArgs,
  UpdateArgs,
  UpsertArgs,
  DeleteArgs,
  CountArgs,
  FieldSelection,
  AggregateArgs,
  AggregateResult,
  GroupByArgs,
  GroupByResult,
  HavingComparison,
  HavingInput,
  MonliteOptions,
  DriverName,
} from "./types.js";
export type { Driver, PreparedStatement } from "./driver/types.js";

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
