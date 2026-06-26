import type { RemoteChange, LocalChange, ConflictResolver } from "@monlite/core";

export type { RemoteChange, LocalChange, ConflictResolver };

/** Opaque resume position. Adapters define the encoding. */
export type Cursor = string | null;

export interface PullOptions {
  /** Restrict to these collections (undefined = all the adapter knows about). */
  collections?: string[];
}

export interface PullResult {
  changes: RemoteChange[];
  cursor: Cursor;
}

export interface PushResult {
  /** Changes the remote accepted (these get marked pushed locally). */
  acked: LocalChange[];
  rejected?: Array<{ change: LocalChange; reason: string }>;
}

export type Unsubscribe = () => void;

/**
 * A pluggable replication backend. MongoDB is the first; `MemoryAdapter` and
 * `MonliteAdapter` ship for testing and monlite-to-monlite sync.
 */
export interface SyncAdapter {
  readonly name: string;
  /** Fetch remote changes since `cursor` (null = from the beginning). */
  pull(cursor: Cursor, opts: PullOptions): Promise<PullResult>;
  /** Apply local changes to the remote. Idempotent, keyed by `_id`. */
  push(changes: LocalChange[]): Promise<PushResult>;
  /** Optional live stream of remote changes (e.g. Mongo change streams). */
  watch?(
    cursor: Cursor,
    onChange: (change: RemoteChange) => void,
    opts: PullOptions,
  ): Unsubscribe;
}

export type SyncMode = "pull" | "push" | "two-way";

export interface SyncOptions {
  adapter: SyncAdapter;
  /** Collections to sync. `"*"` (default) = all local collections. */
  collections?: string[] | "*";
  /** Direction. Default `"two-way"`. */
  mode?: SyncMode;
  /** Conflict strategy. `"lww"` (default) or a custom resolver. */
  conflict?: "lww" | ConflictResolver;
  /** Poll cadence in ms. Omit for manual `.sync()` only. */
  interval?: number;
  /** Subscribe to live changes via `adapter.watch` if available. */
  live?: boolean;
  /** State key for cursors/pointers. Defaults to the adapter name. */
  remote?: string;
  /** Begin syncing immediately (calls `.start()`). */
  autoStart?: boolean;
}

export interface SyncRoundStats {
  pulled: number;
  applied: number;
  conflicts: number;
  pushed: number;
  rejected: number;
}

export interface SyncStatus {
  running: boolean;
  remote: string;
  mode: SyncMode;
  pendingPush: number;
  conflicts: number;
  cursor: Cursor;
  lastPullAt: number | null;
  lastPushAt: number | null;
}
