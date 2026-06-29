import type {
  Doc,
  FindManyArgs,
  LiveEvent,
  WhereInput,
  WithId,
} from "./types.js";

/** Minimal query surface a {@link LiveQuery} needs (satisfied by Collection). */
export interface Queryable<T> {
  readonly name: string;
  findManyCore(args: FindManyArgs<T>): WithId<T>[];
  existsCore(where: WhereInput<T> | undefined): boolean;
}

// Above this many changed ids in one tick, skip the per-row relevance probe and
// just recompute (a giant `_id IN (...)` would be slower than re-running).
const RELEVANCE_PROBE_LIMIT = 500;

/**
 * A live query. Holds the current result set and recomputes only when a changed
 * row is actually relevant to it (row-level matching): either the row is already
 * in the result set, or it now matches the filter.
 */
export class LiveQuery<T = Doc> {
  results: WithId<T>[] = [];
  stopped = false;

  private ids = new Set<string>();

  constructor(
    private readonly source: Queryable<T>,
    private readonly args: FindManyArgs<T>,
    private readonly cb: (event: LiveEvent<T>) => void,
  ) {
    this.recompute("init");
  }

  /** Called by the Reactor with the ids that changed this tick. */
  notify(changedIds: Set<string>): void {
    if (this.stopped) return;
    if (!this.isRelevant(changedIds)) return;
    this.recompute("change", changedIds);
  }

  private isRelevant(changedIds: Set<string>): boolean {
    for (const id of changedIds) {
      if (this.ids.has(id)) return true; // a current member changed/left
    }
    if (changedIds.size > RELEVANCE_PROBE_LIMIT) return true;
    // Does any changed row now match the filter? (row-level entry detection)
    const idIn: WhereInput<T> = {
      _id: { in: [...changedIds] },
    } as WhereInput<T>;
    const where = this.args.where
      ? ({ AND: [this.args.where, idIn] } as WhereInput<T>)
      : idIn;
    return this.source.existsCore(where);
  }

  private recompute(
    type: LiveEvent<T>["type"],
    changedIds?: Set<string>,
  ): void {
    const next = this.source.findManyCore(this.args);
    const nextById = new Map(next.map((d) => [d._id, d] as const));

    const added = next.filter((d) => !this.ids.has(d._id));
    const removed = this.results.filter((d) => !nextById.has(d._id));
    // A doc is "changed" when it was present before and after AND was touched
    // this tick (using the change set, not updated_at, to catch same-ms edits).
    const changed = changedIds
      ? next.filter((d) => this.ids.has(d._id) && changedIds.has(d._id))
      : [];

    this.results = next;
    this.ids = new Set(nextById.keys());

    this.cb({ type, results: next, added, removed, changed });
  }
}

/**
 * In-process reactivity hub. Collections emit `(collection, ids)` after each
 * write; the reactor coalesces them per microtask and notifies live queries.
 */
export class Reactor {
  private readonly byCollection = new Map<string, Set<LiveQuery<any>>>();
  private readonly pending = new Map<string, Set<string>>();
  private flushScheduled = false;

  hasWatchers(collection: string): boolean {
    return this.byCollection.has(collection);
  }

  register(collection: string, lq: LiveQuery<any>): void {
    let set = this.byCollection.get(collection);
    if (!set) this.byCollection.set(collection, (set = new Set()));
    set.add(lq);
  }

  unregister(collection: string, lq: LiveQuery<any>): void {
    const set = this.byCollection.get(collection);
    if (!set) return;
    set.delete(lq);
    if (set.size === 0) this.byCollection.delete(collection);
  }

  /** Record that documents changed; schedule a notification flush. */
  emit(collection: string, ids: string[]): void {
    const set = this.byCollection.get(collection);
    if (!set || set.size === 0 || ids.length === 0) return;
    let p = this.pending.get(collection);
    if (!p) this.pending.set(collection, (p = new Set()));
    for (const id of ids) p.add(id);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const work = [...this.pending];
    this.pending.clear();
    for (const [collection, ids] of work) {
      const set = this.byCollection.get(collection);
      if (!set) continue;
      for (const lq of [...set]) {
        try {
          lq.notify(ids);
        } catch (err) {
          // A throwing watch callback must not break sibling watchers or wedge the
          // reactor (and must not crash the host app). Report it and carry on.
          console.error("monlite: a watch() callback threw —", err);
        }
      }
    }
  }
}
