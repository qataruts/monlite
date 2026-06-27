import type { Monlite } from "@monlite/core";

export interface KVOptions {
  /** Logical namespace so multiple caches can share one database. Default "default". */
  namespace?: string;
  /** If set, a timer periodically purges expired keys (ms). Default: lazy-only. */
  sweepIntervalMs?: number;
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
  /** Stop the sweep timer (if any). */
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
      )`,
    );
    ensured.add(db);
  }

  const now = () => Date.now();
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
      setRaw(key, JSON.stringify(value), expires);
    },
    setNX(key, value, opts) {
      return driver.transaction(() => {
        const row = getRow(key);
        if (fresh(row)) return false; // a live key already exists
        const expires = opts?.ttl != null ? now() + opts.ttl : null;
        setRaw(key, JSON.stringify(value), expires);
        return true;
      });
    },
    has(key) {
      return api.get(key) !== undefined;
    },
    delete(key) {
      return del(key);
    },
    incr(key, by = 1) {
      return driver.transaction(() => {
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
      });
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
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
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
