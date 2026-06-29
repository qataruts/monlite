import type { Monlite, HeartbeatTask } from "@monlite/core";

export interface KVOptions {
  /** Logical namespace so multiple caches can share one database. Default "default". */
  namespace?: string;
  /** If set, a timer periodically purges expired keys (ms). Default: lazy-only. */
  sweepIntervalMs?: number;
  /** How often (ms) a `subscribe()` listener polls for cross-process messages. Default `200`. */
  pubsubPollMs?: number;
}

/**
 * A synchronous, Redis-like key-value cache backed by SQLite. Values are any
 * JSON-serializable data; TTLs are in milliseconds.
 */
export interface KV {
  get<T = any>(key: string): T | undefined;
  set(key: string, value: any, opts?: { ttl?: number }): void;
  /**
   * Atomically set the key only if it isn't already present (Redis `SET NX`).
   * Returns `true` if set, `false` if a live key already existed. The lock
   * primitive for single-instance schedulers, nonces, and once-only work.
   */
  setNX(key: string, value: any, opts?: { ttl?: number }): boolean;
  has(key: string): boolean;
  delete(key: string): boolean;
  /** Atomically add `by` (default 1) to a numeric key; returns the new value. */
  incr(key: string, by?: number): number;
  decr(key: string, by?: number): number;
  mget<T = any>(keys: string[]): (T | undefined)[];
  /** Keys in this namespace (optionally by prefix), excluding expired ones. */
  keys(prefix?: string): string[];
  /** Set/refresh a key's TTL (ms). Returns false if the key is absent. */
  expire(key: string, ttl: number): boolean;
  /** Remaining TTL in ms; `-1` if no expiry, `-2` if absent (Redis convention). */
  ttl(key: string): number;
  /** Delete all keys in this namespace. */
  flush(): void;
  /** Number of live keys in this namespace. */
  size(): number;
  /**
   * Publish a message to a channel (Redis `PUBLISH`). Delivered to every
   * `subscribe()` listener on that channel — including in OTHER processes
   * sharing this database. Ephemeral: not replayed to late subscribers. Returns
   * the number of listeners on this instance that received it.
   */
  publish(channel: string, message: any): number;
  /**
   * Subscribe to a channel (Redis `SUBSCRIBE`). The callback fires for each
   * message published AFTER this call, cross-process. Returns an unsubscribe.
   */
  subscribe(channel: string, cb: (message: any) => void): () => void;
  /** Stop the sweep + pub/sub timers (if any). */
  stop(): void;
}

const ensured = new WeakSet<object>();

/**
 * Create a cache over a monlite database.
 *
 * ```ts
 * const cache = kv(db);
 * cache.set("session:42", { user: "ali" }, { ttl: 60_000 });
 * cache.get("session:42"); // { user: "ali" }  (synchronous)
 * ```
 */
export function kv(db: Monlite, options: KVOptions = {}): KV {
  const ns = options.namespace ?? "default";
  const driver = db.driver;

  if (!ensured.has(db)) {
    driver.exec(
      `CREATE TABLE IF NOT EXISTS _kv (
        ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
        expires_at INTEGER, PRIMARY KEY (ns, k)
      );
      CREATE TABLE IF NOT EXISTS _monlite_kv_pubsub (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ns TEXT NOT NULL, channel TEXT NOT NULL, payload TEXT, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS _idx_kv_pubsub ON _monlite_kv_pubsub (ns, seq)`,
    );
    ensured.add(db);
  }

  const now = () => Date.now();
  const pubsubPollMs = Math.max(20, options.pubsubPollMs ?? 200);
  const fresh = (row: any): boolean =>
    !!row && !(row.expires_at != null && row.expires_at <= now());

  const getRow = (key: string) =>
    driver
      .prepare(`SELECT v, expires_at FROM _kv WHERE ns = ? AND k = ?`)
      .get(ns, key) as { v: string; expires_at: number | null } | undefined;

  const del = (key: string): boolean =>
    driver.prepare(`DELETE FROM _kv WHERE ns = ? AND k = ?`).run(ns, key)
      .changes > 0;

  const setRaw = (key: string, v: string, expires: number | null) =>
    driver
      .prepare(
        `INSERT INTO _kv (ns, k, v, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`,
      )
      .run(ns, key, v, expires);

  let timer: ReturnType<typeof setInterval> | undefined;

  // ── pub/sub ──────────────────────────────────────────────────────────────
  type Sub = { channel: string; cb: (m: any) => void; cursor: number };
  const subs = new Set<Sub>();
  let psTask: HeartbeatTask | undefined;

  const psMaxSeq = (): number =>
    (
      driver
        .prepare(`SELECT MAX(seq) AS s FROM _monlite_kv_pubsub WHERE ns = ?`)
        .get(ns) as { s: number | null }
    ).s ?? 0;

  /** Deliver new messages to every local subscriber (cross-process via the table). */
  const drainPubsub = (): void => {
    if (subs.size === 0) return;
    let min = Infinity;
    for (const s of subs) min = Math.min(min, s.cursor);
    const rows = driver
      .prepare(
        `SELECT seq, channel, payload FROM _monlite_kv_pubsub WHERE ns = ? AND seq > ? ORDER BY seq`,
      )
      .all(ns, min) as Array<{ seq: number; channel: string; payload: string }>;
    if (rows.length === 0) return;
    for (const s of [...subs]) {
      for (const r of rows) {
        if (r.seq <= s.cursor) continue;
        s.cursor = r.seq;
        if (r.channel === s.channel) {
          try {
            s.cb(JSON.parse(r.payload ?? "null"));
          } catch {
            /* a subscriber callback must not break delivery to others */
          }
        }
      }
    }
  };

  const api: KV = {
    get(key) {
      const row = getRow(key);
      if (!fresh(row)) {
        if (row) del(key);
        return undefined;
      }
      return JSON.parse(row!.v);
    },
    set(key, value, opts) {
      const expires = opts?.ttl != null ? now() + opts.ttl : null;
      // `?? null` so `set(key, undefined)` stores JSON null (round-trips to null)
      // instead of binding `undefined` and tripping the NOT NULL constraint.
      setRaw(key, JSON.stringify(value ?? null), expires);
    },
    setNX(key, value, opts) {
      // IMMEDIATE: take the write lock up front so two processes racing the same
      // key can't deadlock on lock upgrade — the loser cleanly gets `false`.
      return driver.transaction(() => {
        const row = getRow(key);
        if (fresh(row)) return false; // a live key already exists
        const expires = opts?.ttl != null ? now() + opts.ttl : null;
        // `?? null` so `set(key, undefined)` stores JSON null (round-trips to null)
        // instead of binding `undefined` and tripping the NOT NULL constraint.
        setRaw(key, JSON.stringify(value ?? null), expires);
        return true;
      }, true);
    },
    has(key) {
      return api.get(key) !== undefined;
    },
    delete(key) {
      return del(key);
    },
    incr(key, by = 1) {
      return driver.transaction(() => {
        // IMMEDIATE: read-modify-write needs the write lock up front
        const row = getRow(key);
        let n = 0;
        let expires: number | null = null;
        if (fresh(row)) {
          const cur = JSON.parse(row!.v);
          if (typeof cur !== "number") {
            throw new Error(`kv.incr: value at "${key}" is not a number`);
          }
          n = cur;
          expires = row!.expires_at;
        }
        const next = n + by;
        setRaw(key, JSON.stringify(next), expires);
        return next;
      }, true);
    },
    decr(key, by = 1) {
      return api.incr(key, -by);
    },
    mget(keys) {
      return keys.map((k) => api.get(k));
    },
    keys(prefix) {
      const t = now();
      const rows = (
        prefix !== undefined
          ? driver
              .prepare(
                `SELECT k, expires_at FROM _kv WHERE ns = ? AND k LIKE ? ESCAPE '\\'`,
              )
              .all(ns, prefix.replace(/[%_\\]/g, "\\$&") + "%")
          : driver.prepare(`SELECT k, expires_at FROM _kv WHERE ns = ?`).all(ns)
      ) as Array<{ k: string; expires_at: number | null }>;
      return rows
        .filter((r) => r.expires_at == null || r.expires_at > t)
        .map((r) => r.k);
    },
    expire(key, ttl) {
      const row = getRow(key);
      if (!fresh(row)) return false;
      driver
        .prepare(`UPDATE _kv SET expires_at = ? WHERE ns = ? AND k = ?`)
        .run(now() + ttl, ns, key);
      return true;
    },
    ttl(key) {
      const row = getRow(key);
      if (!fresh(row)) return -2;
      if (row!.expires_at == null) return -1;
      return row!.expires_at - now();
    },
    flush() {
      driver.prepare(`DELETE FROM _kv WHERE ns = ?`).run(ns);
    },
    size() {
      return (
        driver
          .prepare(
            `SELECT COUNT(*) AS n FROM _kv WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .get(ns, now()) as { n: number }
      ).n;
    },
    publish(channel, message) {
      const ts = now();
      driver
        .prepare(
          `INSERT INTO _monlite_kv_pubsub (ns, channel, payload, ts) VALUES (?, ?, ?, ?)`,
        )
        .run(ns, channel, JSON.stringify(message ?? null), ts);
      // Ephemeral: prune old messages (late subscribers don't replay) so the
      // table can't grow unbounded.
      driver
        .prepare(`DELETE FROM _monlite_kv_pubsub WHERE ts < ?`)
        .run(ts - 30_000);
      // Deliver to same-instance subscribers immediately (cross-process listeners
      // pick it up on their next poll).
      drainPubsub();
      let n = 0;
      for (const s of subs) if (s.channel === channel) n++;
      return n;
    },
    subscribe(channel, cb) {
      const sub: Sub = { channel, cb, cursor: psMaxSeq() }; // start at "now" — no replay
      subs.add(sub);
      // Register the cross-process poll on the shared heartbeat (one timer for the
      // whole db), started on first subscribe and dropped when the last unsubscribes.
      if (!psTask) psTask = db.heartbeat.every(pubsubPollMs, drainPubsub);
      return () => {
        subs.delete(sub);
        if (subs.size === 0 && psTask) {
          psTask.cancel();
          psTask = undefined;
        }
      };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (psTask) {
        psTask.cancel();
        psTask = undefined;
      }
    },
  };

  if (options.sweepIntervalMs && options.sweepIntervalMs > 0) {
    timer = setInterval(() => {
      driver
        .prepare(
          `DELETE FROM _kv WHERE expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .run(now());
    }, options.sweepIntervalMs);
    timer.unref?.();
  }

  return api;
}
