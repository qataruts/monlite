import type { Monlite } from "./db.js";
import type { Collection } from "./collection.js";

/** Documents that changed in a single write, delivered to `afterWrite`. */
export interface PluginChange {
  collection: string;
  ids: string[];
}

/**
 * A monlite plugin. Plugins keep `@monlite/core` lean — heavier or optional
 * capabilities (full-text search, vector, encryption) live in their own
 * packages and hook in here.
 */
export interface MonlitePlugin {
  name: string;
  /** Called once when the database opens (e.g. to create auxiliary tables). */
  init?(db: Monlite): void;
  /**
   * Called synchronously after every committed write (including changes applied
   * by `@monlite/sync`), so derived state like a search index stays in sync.
   */
  afterWrite?(db: Monlite, change: PluginChange): void;
  /**
   * Methods to attach to every collection handle (e.g. `search`). The impl
   * receives the collection as its first argument, then the caller's arguments.
   */
  collectionMethods?: Record<
    string,
    (collection: Collection<any>, ...args: any[]) => any
  >;
}
