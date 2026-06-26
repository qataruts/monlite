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
  MonliteOptions,
  DriverName,
} from "./types.js";
export type { Driver, PreparedStatement } from "./driver/types.js";

// Convenience aliases.
export type { Monlite as Db } from "./db.js";
export type { WhereInput as WhereClause } from "./types.js";
