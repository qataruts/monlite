import type {
  Doc,
  FindManyArgs,
  LiveEvent,
  WatchArgs,
  WhereInput,
  WithId,
} from "./types.js";
import type { AsyncDriver } from "./driver/types.js";
import { project } from "./query/select.js";

// Coalesce a burst of NOTIFYs (e.g. a createMany's per-row triggers) before re-querying.
const PG_NOTIFY_DEBOUNCE_MS = 5;

/** Structural equality for document field values (scalars fast-path, else JSON). */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" && typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field names whose value differs between two docs (system timestamps ignored). */
function diffFields(
  prev: Record<string, any>,
  next: Record<string, any>,
): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === "_id" || k === "created_at" || k === "updated_at") continue;
    if (!valueEquals(prev[k], next[k])) out.push(k);
  }
  return out;
}

/** Minimal query surface a {@link LiveQuery} needs (satisfied by Collection). */
export interface Queryable<T> {
  readonly name: string;
  findManyCore(args: FindManyArgs<T>): WithId<T>[];
  existsCore(where: WhereInput<T> | undefined): boolean;
}

// Above this many changed ids in one tick, skip the per-row relevance probe and
// just recompute (a giant `_id IN (...)` would be slower than re-running).
const RELEVANCE_PROBE_LIMIT = 500;

/** Outcome of a recompute: the (possibly suppressed) event + the new state to store. */
export interface LiveComputeResult<T> {
  /** The event to emit, or `null` when a field-scoped change touched nothing watched. */
  event: LiveEvent<T> | null;
  full: WithId<T>[];
  ids: Set<string>;
  results: WithId<T>[];
}

/**
 * Pure delta engine: given the previous and freshly-read result sets, compute the
 * added / removed / changed / moved diff and the projected event. Shared by the
 * synchronous {@link LiveQuery} (SQLite) and the async PgLiveQuery (Postgres) so the
 * two engines can never diverge — only how `next` is fetched differs.
 */
export function computeLiveEvent<T>(
  type: LiveEvent<T>["type"],
  prev: WithId<T>[],
  next: WithId<T>[],
  changedIds: Set<string> | undefined,
  args: WatchArgs<T>,
  fieldSet: Set<string> | undefined,
): LiveComputeResult<T> {
  const prevById = new Map(prev.map((d) => [d._id, d] as const));
  const prevIds = new Set(prevById.keys());
  const nextById = new Map(next.map((d) => [d._id, d] as const));

  const added = next.filter((d) => !prevIds.has(d._id));
  const removed = prev.filter((d) => !nextById.has(d._id));
  // A doc is "changed" when present before and after AND touched this tick
  // (using the change set, not updated_at, to catch same-ms edits).
  const changed = changedIds
    ? next.filter((d) => prevIds.has(d._id) && changedIds.has(d._id))
    : [];

  // Per-doc changed field names (diff old vs new) for the `changed` set.
  let changedFields: Record<string, string[]> | undefined;
  if (changed.length) {
    changedFields = {};
    for (const d of changed) {
      const old = prevById.get(d._id);
      changedFields[d._id] = old
        ? diffFields(old as any, d as any)
        : Object.keys(d);
    }
  }

  // `moved`: only meaningful for an ordered query — a surviving doc whose RANK
  // among the survivors changed (ignores shifts caused by add/remove).
  let moved: WithId<T>[] | undefined;
  if (args.orderBy && prev.length) {
    const oldRank = new Map<string, number>();
    prev
      .filter((d) => nextById.has(d._id))
      .forEach((d, i) => oldRank.set(d._id, i));
    const m: WithId<T>[] = [];
    next
      .filter((d) => prevById.has(d._id))
      .forEach((d, i) => {
        if (oldRank.get(d._id) !== i) m.push(d);
      });
    if (m.length) moved = m;
  }

  const sel = args.select;
  const proj = (docs: WithId<T>[]): WithId<T>[] =>
    sel ? docs.map((d) => project(d as any, sel as any) as WithId<T>) : docs;
  const results = proj(next);
  const ids = new Set(nextById.keys());

  // Field-scoped: suppress a pure "change" that touched no watched field (but
  // always deliver init, structural add/remove, and position moves).
  if (
    type === "change" &&
    fieldSet &&
    added.length === 0 &&
    removed.length === 0 &&
    !moved
  ) {
    const touched = changed.some((d) =>
      (changedFields?.[d._id] ?? []).some((f) => fieldSet.has(f)),
    );
    if (!touched) return { event: null, full: next, ids, results };
  }

  return {
    event: {
      type,
      results,
      added: proj(added),
      removed: proj(removed),
      changed: proj(changed),
      moved: moved ? proj(moved) : undefined,
      changedFields,
    },
    full: next,
    ids,
    results,
  };
}

/**
 * A live query. Holds the current result set and recomputes only when a changed
 * row is actually relevant to it (row-level matching): either the row is already
 * in the result set, or it now matches the filter.
 */
export class LiveQuery<T = Doc> {
  /** Result set as the caller sees it (projected by `select`, if any). */
  results: WithId<T>[] = [];
  stopped = false;

  /** Full (unprojected) result set — identity + diffing always run on this so a
   *  `select` that omits `_id`/changed fields can't corrupt the delta engine. */
  private full: WithId<T>[] = [];
  private ids = new Set<string>();
  /** When set, only emit a "change" if one of these fields changed. */
  private readonly fieldSet?: Set<string>;

  constructor(
    private readonly source: Queryable<T>,
    private readonly args: WatchArgs<T>,
    private readonly cb: (event: LiveEvent<T>) => void,
  ) {
    if (args.fields?.length)
      this.fieldSet = new Set(args.fields.map((f) => String(f)));
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
    // Always read FULL docs for bookkeeping (drop `select`); the delta engine
    // projects only at the emit boundary — a `select` omitting `_id` must not
    // corrupt identity/diffing.
    const next = this.source.findManyCore({ ...this.args, select: undefined });
    const r = computeLiveEvent(
      type,
      this.full,
      next,
      changedIds,
      this.args,
      this.fieldSet,
    );
    this.full = r.full;
    this.ids = r.ids;
    this.results = r.results;
    if (r.event) this.cb(r.event);
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

  /** True if any collection has at least one live watcher. */
  hasAnyWatchers(): boolean {
    return this.byCollection.size > 0;
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

/** Async re-query for a {@link PgLiveQuery} — Collection's `findMany` on Postgres. */
export type AsyncQuery<T> = (args: FindManyArgs<T>) => Promise<WithId<T>[]>;

/**
 * The Postgres counterpart of {@link LiveQuery}: identical delta engine
 * ({@link computeLiveEvent}), but the result set is re-read asynchronously — a NOTIFY
 * tells us which ids changed, we re-query and diff. One per `watch()` call.
 */
export class PgLiveQuery<T = Doc> {
  results: WithId<T>[] = [];
  stopped = false;
  private full: WithId<T>[] = [];
  private ids = new Set<string>();
  private readonly fieldSet?: Set<string>;
  /** Serializes recomputes so init + concurrent notifies can't interleave/clobber state. */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly query: AsyncQuery<T>,
    private readonly args: WatchArgs<T>,
    private readonly cb: (event: LiveEvent<T>) => void,
  ) {
    if (args.fields?.length)
      this.fieldSet = new Set(args.fields.map((f) => String(f)));
  }

  /** First read — emits the "init" event. */
  async init(): Promise<void> {
    await this.recompute("init");
  }

  /** A NOTIFY tick delivered these changed ids — re-query and diff. */
  async notify(changedIds: Set<string>): Promise<void> {
    if (this.stopped) return;
    await this.recompute("change", changedIds);
  }

  /** Enqueue a recompute on the per-query tail so reads + diffs never interleave. */
  private recompute(
    type: LiveEvent<T>["type"],
    changedIds?: Set<string>,
  ): Promise<void> {
    const run = this.tail.then(() => this.doRecompute(type, changedIds));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRecompute(
    type: LiveEvent<T>["type"],
    changedIds?: Set<string>,
  ): Promise<void> {
    if (this.stopped) return;
    const next = await this.query({ ...this.args, select: undefined });
    if (this.stopped) return;
    const r = computeLiveEvent(
      type,
      this.full,
      next,
      changedIds,
      this.args,
      this.fieldSet,
    );
    this.full = r.full;
    this.ids = r.ids;
    this.results = r.results;
    if (!r.event) return;
    // Suppress a "change" tick that produced no delta (a NOTIFY for a row not in,
    // and not entering, this query) — init/add/remove/move always deliver.
    if (
      type === "change" &&
      r.event.added.length === 0 &&
      r.event.removed.length === 0 &&
      r.event.changed.length === 0 &&
      !r.event.moved
    )
      return;
    this.cb(r.event);
  }
}

/**
 * Routes Postgres `LISTEN/NOTIFY` to {@link PgLiveQuery} watchers — one per database.
 * A trigger NOTIFYs `monlite_<table>` with the changed `_id` on every write (from any
 * connection, so realtime is truly cross-process); this coalesces the ids arriving in
 * a tick and re-queries each affected watcher once.
 */
export class PgReactor {
  private readonly queries = new Map<string, Set<PgLiveQuery<any>>>();
  private readonly unlisten = new Map<string, () => void | Promise<void>>();
  private pending = new Map<string, Set<string>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The in-flight flush, so stop() can wait for it before the pool closes. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly driver: AsyncDriver) {}

  channel(collection: string): string {
    return `monlite_${collection}`;
  }

  async register(collection: string, lq: PgLiveQuery<any>): Promise<void> {
    let set = this.queries.get(collection);
    if (!set) {
      this.queries.set(collection, (set = new Set()));
      try {
        const un = await this.driver.listen!(
          this.channel(collection),
          (payload) => this.onNotify(collection, payload),
        );
        // A watcher may have been torn down while we awaited LISTEN.
        if (this.queries.get(collection) === set)
          this.unlisten.set(collection, un);
        else await un();
      } catch (err) {
        // LISTEN failed — drop the empty set we optimistically inserted, otherwise a
        // later watch() sees a truthy set, skips LISTEN, and silently gets no NOTIFYs.
        if (this.queries.get(collection) === set && set.size === 0)
          this.queries.delete(collection);
        throw err;
      }
    }
    // Start the init read FIRST (it enqueues on lq's serialized tail), THEN make the
    // query visible to flush() — so a NOTIFY arriving now can't deliver a "change"
    // ahead of the "init".
    const ready = lq.init();
    set.add(lq);
    await ready;
  }

  async unregister(collection: string, lq: PgLiveQuery<any>): Promise<void> {
    const set = this.queries.get(collection);
    if (!set) return;
    set.delete(lq);
    if (set.size === 0) {
      this.queries.delete(collection);
      const un = this.unlisten.get(collection);
      this.unlisten.delete(collection);
      if (un) await un();
    }
  }

  private onNotify(collection: string, id: string): void {
    let ids = this.pending.get(collection);
    if (!ids) this.pending.set(collection, (ids = new Set()));
    ids.add(id);
    if (!this.flushTimer) {
      const t = setTimeout(() => {
        this.flushing = this.flush();
      }, PG_NOTIFY_DEBOUNCE_MS);
      t.unref?.(); // don't keep the process alive for a debounce tick
      this.flushTimer = t;
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = new Map();
    for (const [collection, ids] of batch) {
      const set = this.queries.get(collection);
      if (!set) continue;
      for (const lq of [...set]) {
        try {
          await lq.notify(ids);
        } catch (err) {
          console.error("monlite: a watch() callback threw —", err);
        }
      }
    }
  }

  hasAnyWatchers(): boolean {
    return this.queries.size > 0;
  }

  /** Tear down all subscriptions (called on `$disconnect`). */
  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    // Mark every live query stopped so a settling flush delivers nothing, then wait
    // for an in-flight flush so we don't query the pool that close() is about to end.
    for (const set of this.queries.values())
      for (const lq of set) lq.stopped = true;
    try {
      await this.flushing;
    } catch {
      /* a flush failure during shutdown is irrelevant */
    }
    const uns = [...this.unlisten.values()];
    this.unlisten.clear();
    this.queries.clear();
    for (const un of uns) {
      try {
        await un();
      } catch {
        /* shutting down */
      }
    }
  }
}
