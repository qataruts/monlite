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

  // ── sorted sets (Redis ZSET) — leaderboards, rate-limiters, priority indexes ──
  /** Add or update `member` with `score` (Redis `ZADD`). */
  zadd(key: string, score: number, member: string): void;
  /** Increment `member`'s score by `delta` (`ZINCRBY`); returns the new score. */
  zincrby(key: string, delta: number, member: string): number;
  /** A member's score, or `undefined` if absent (`ZSCORE`). */
  zscore(key: string, member: string): number | undefined;
  /** Remove `member` (`ZREM`); returns `true` if it existed. */
  zrem(key: string, member: string): boolean;
  /** Number of members (`ZCARD`). */
  zcard(key: string): number;
  /** 0-based rank by ascending score (ties lexicographic); `rev` for descending. `undefined` if absent. */
  zrank(
    key: string,
    member: string,
    opts?: { rev?: boolean },
  ): number | undefined;
  /**
   * Members by rank range `[start, stop]` inclusive (negative counts from the end,
   * Redis-style), ascending by score (`rev` = descending). With `withScores`,
   * returns `{ member, score }[]` (`ZRANGE` / `ZREVRANGE`).
   */
  zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { rev?: boolean; withScores?: boolean },
  ): string[] | Array<{ member: string; score: number }>;
  /** Members with `min <= score <= max`, ascending (`ZRANGEBYSCORE`). */
  zrangeByScore(
    key: string,
    min: number,
    max: number,
    opts?: { withScores?: boolean },
  ): string[] | Array<{ member: string; score: number }>;

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
  if (db.asyncDriver)
    throw new Error(
      "@monlite/kv: the Postgres engine is asynchronous — use `pgKv(db)` (its methods " +
        "return Promises). `kv()` is the synchronous SQLite engine.",
    );
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
      CREATE INDEX IF NOT EXISTS _idx_kv_pubsub ON _monlite_kv_pubsub (ns, seq);
      CREATE TABLE IF NOT EXISTS _monlite_kv_zset (
        ns TEXT NOT NULL, k TEXT NOT NULL, member TEXT NOT NULL, score REAL NOT NULL,
        PRIMARY KEY (ns, k, member)
      );
      CREATE INDEX IF NOT EXISTS _idx_kv_zset ON _monlite_kv_zset (ns, k, score, member)`,
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

    // ── sorted sets ──────────────────────────────────────────────────────────
    zadd(key, score, member) {
      if (typeof score !== "number" || Number.isNaN(score))
        throw new Error(`kv.zadd: score must be a number, got ${score}`);
      driver
        .prepare(
          `INSERT INTO _monlite_kv_zset (ns, k, member, score) VALUES (?, ?, ?, ?)
           ON CONFLICT(ns, k, member) DO UPDATE SET score = excluded.score`,
        )
        .run(ns, key, member, score);
    },
    zincrby(key, delta, member) {
      if (typeof delta !== "number" || Number.isNaN(delta))
        throw new Error(`kv.zincrby: delta must be a number, got ${delta}`);
      // IMMEDIATE: atomic read-modify-write across processes.
      return driver.transaction(() => {
        const row = driver
          .prepare(
            `SELECT score FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
          )
          .get(ns, key, member) as { score: number } | undefined;
        const next = (row?.score ?? 0) + delta;
        driver
          .prepare(
            `INSERT INTO _monlite_kv_zset (ns, k, member, score) VALUES (?, ?, ?, ?)
             ON CONFLICT(ns, k, member) DO UPDATE SET score = excluded.score`,
          )
          .run(ns, key, member, next);
        return next;
      }, true);
    },
    zscore(key, member) {
      const row = driver
        .prepare(
          `SELECT score FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
        )
        .get(ns, key, member) as { score: number } | undefined;
      return row?.score;
    },
    zrem(key, member) {
      return (
        driver
          .prepare(
            `DELETE FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
          )
          .run(ns, key, member).changes > 0
      );
    },
    zcard(key) {
      return (
        driver
          .prepare(
            `SELECT COUNT(*) AS n FROM _monlite_kv_zset WHERE ns = ? AND k = ?`,
          )
          .get(ns, key) as { n: number }
      ).n;
    },
    zrank(key, member, opts) {
      const row = driver
        .prepare(
          `SELECT score FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
        )
        .get(ns, key, member) as { score: number } | undefined;
      if (!row) return undefined;
      // Members ordered before this one (ties broken lexicographically by member).
      const cmp = opts?.rev
        ? `score > ? OR (score = ? AND member > ?)`
        : `score < ? OR (score = ? AND member < ?)`;
      return (
        driver
          .prepare(
            `SELECT COUNT(*) AS n FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND (${cmp})`,
          )
          .get(ns, key, row.score, row.score, member) as { n: number }
      ).n;
    },
    zrange(key, start, stop, opts) {
      // Floor rank args so a fractional index can't reach SQLite's LIMIT/OFFSET
      // (which would throw "datatype mismatch").
      start = Math.trunc(start);
      stop = Math.trunc(stop);
      const card = api.zcard(key);
      let lo = start < 0 ? card + start : start;
      let hi = stop < 0 ? card + stop : stop;
      if (lo < 0) lo = 0;
      if (hi >= card) hi = card - 1;
      if (card === 0 || lo > hi) return [];
      const dir = opts?.rev ? "DESC" : "ASC";
      const rows = driver
        .prepare(
          `SELECT member, score FROM _monlite_kv_zset WHERE ns = ? AND k = ?
           ORDER BY score ${dir}, member ${dir} LIMIT ? OFFSET ?`,
        )
        .all(ns, key, hi - lo + 1, lo) as Array<{
        member: string;
        score: number;
      }>;
      return opts?.withScores ? rows : rows.map((r) => r.member);
    },
    zrangeByScore(key, min, max, opts) {
      const rows = driver
        .prepare(
          `SELECT member, score FROM _monlite_kv_zset WHERE ns = ? AND k = ?
           AND score >= ? AND score <= ? ORDER BY score ASC, member ASC`,
        )
        .all(ns, key, min, max) as Array<{ member: string; score: number }>;
      return opts?.withScores ? rows : rows.map((r) => r.member);
    },

    publish(channel, message) {
      const ts = now();
      driver
        .prepare(
          `INSERT INTO _monlite_kv_pubsub (ns, channel, payload, ts) VALUES (?, ?, ?, ?)`,
        )
        .run(ns, channel, JSON.stringify(message ?? null), ts);
      // Ephemeral: prune THIS namespace's old messages (late subscribers don't
      // replay) so the table can't grow unbounded — scoped to `ns` so a busy
      // namespace can't drop another's still-unread messages.
      driver
        .prepare(`DELETE FROM _monlite_kv_pubsub WHERE ns = ? AND ts < ?`)
        .run(ns, ts - 30_000);
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

// ── Postgres engine: async Redis-like cache ───────────────────────────────────
//
// The same model as {@link kv} (namespaced _kv, sorted sets, table-backed cross-process
// pub/sub), with an async API. `await cache.get(...)`.
const pgEnsured = new WeakSet<object>();

/** The Postgres counterpart of {@link KV} — identical surface, every method async. */
export interface PgKV {
  get<T = any>(key: string): Promise<T | undefined>;
  set(key: string, value: any, opts?: { ttl?: number }): Promise<void>;
  setNX(key: string, value: any, opts?: { ttl?: number }): Promise<boolean>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  incr(key: string, by?: number): Promise<number>;
  decr(key: string, by?: number): Promise<number>;
  mget<T = any>(keys: string[]): Promise<(T | undefined)[]>;
  keys(prefix?: string): Promise<string[]>;
  expire(key: string, ttl: number): Promise<boolean>;
  ttl(key: string): Promise<number>;
  flush(): Promise<void>;
  size(): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zincrby(key: string, delta: number, member: string): Promise<number>;
  zscore(key: string, member: string): Promise<number | undefined>;
  zrem(key: string, member: string): Promise<boolean>;
  zcard(key: string): Promise<number>;
  zrank(
    key: string,
    member: string,
    opts?: { rev?: boolean },
  ): Promise<number | undefined>;
  zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { rev?: boolean; withScores?: boolean },
  ): Promise<string[] | Array<{ member: string; score: number }>>;
  zrangeByScore(
    key: string,
    min: number,
    max: number,
    opts?: { withScores?: boolean },
  ): Promise<string[] | Array<{ member: string; score: number }>>;
  publish(channel: string, message: any): Promise<number>;
  subscribe(channel: string, cb: (message: any) => void): () => void;
  stop(): void;
}

/**
 * Create a Redis-like cache over a monlite database on the **Postgres** engine.
 *
 * ```ts
 * const cache = pgKv(db);
 * await cache.set("session:42", { user: "ali" }, { ttl: 60_000 });
 * await cache.get("session:42"); // { user: "ali" }
 * ```
 */
export function pgKv(db: Monlite, options: KVOptions = {}): PgKV {
  if (!db.asyncDriver)
    throw new Error(
      "@monlite/kv: pgKv requires the Postgres engine — use `kv(db)` on the SQLite engine.",
    );
  const ns = options.namespace ?? "default";
  const driver = db.asyncDriver;
  const now = () => Date.now();
  const pubsubPollMs = Math.max(20, options.pubsubPollMs ?? 200);

  const ready = pgEnsured.has(db)
    ? Promise.resolve()
    : (async () => {
        await driver.exec(
          `CREATE TABLE IF NOT EXISTS _kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
            expires_at BIGINT, PRIMARY KEY (ns, k))`,
        );
        await driver.exec(
          `CREATE TABLE IF NOT EXISTS _monlite_kv_pubsub (seq BIGSERIAL PRIMARY KEY,
            ns TEXT NOT NULL, channel TEXT NOT NULL, payload TEXT, ts BIGINT NOT NULL)`,
        );
        await driver.exec(
          `CREATE INDEX IF NOT EXISTS _idx_kv_pubsub ON _monlite_kv_pubsub (ns, seq)`,
        );
        await driver.exec(
          `CREATE TABLE IF NOT EXISTS _monlite_kv_zset (ns TEXT NOT NULL, k TEXT NOT NULL,
            member TEXT NOT NULL, score double precision NOT NULL, PRIMARY KEY (ns, k, member))`,
        );
        await driver.exec(
          `CREATE INDEX IF NOT EXISTS _idx_kv_zset ON _monlite_kv_zset (ns, k, score, member)`,
        );
        // Mark ready only AFTER the DDL succeeds — otherwise a concurrent second
        // pgKv(db) would see `has(db)`, skip the DDL, and query missing tables. A
        // failure leaves the db unmarked so a later pgKv retries the setup.
        pgEnsured.add(db);
      })();

  const q = async (sql: string, params: any[] = []) => {
    await ready;
    return driver.query(sql, params);
  };
  const fresh = (row: any): boolean =>
    !!row && !(row.expires_at != null && Number(row.expires_at) <= now());
  const getRow = async (key: string) =>
    (await q(`SELECT v, expires_at FROM _kv WHERE ns = ? AND k = ?`, [ns, key]))
      .rows[0] as { v: string; expires_at: any } | undefined;
  const del = async (key: string): Promise<boolean> =>
    (await q(`DELETE FROM _kv WHERE ns = ? AND k = ?`, [ns, key])).changes > 0;
  const setRaw = (key: string, v: string, expires: number | null) =>
    q(
      `INSERT INTO _kv (ns, k, v, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`,
      [ns, key, v, expires],
    );

  // ── pub/sub (table-backed, cross-process; polled on the shared heartbeat) ──
  type Sub = { channel: string; cb: (m: any) => void; cursor: number };
  const subs = new Set<Sub>();
  let psTask: HeartbeatTask | undefined;
  const psMaxSeq = async (): Promise<number> =>
    Number(
      (
        await q(`SELECT MAX(seq) AS s FROM _monlite_kv_pubsub WHERE ns = ?`, [
          ns,
        ])
      ).rows[0]?.s ?? 0,
    );
  const drainPubsub = async (): Promise<void> => {
    if (subs.size === 0) return;
    let min = Infinity;
    for (const s of subs) min = Math.min(min, s.cursor);
    // Every subscriber is still snapshotting its high-water seq (cursor=Infinity) —
    // there's nothing to deliver yet, and binding Infinity as a BIGINT would error.
    if (!Number.isFinite(min)) return;
    const rows = (
      await q(
        `SELECT seq, channel, payload FROM _monlite_kv_pubsub WHERE ns = ? AND seq > ? ORDER BY seq`,
        [ns, min],
      )
    ).rows as Array<{ seq: any; channel: string; payload: string }>;
    if (rows.length === 0) return;
    for (const s of [...subs]) {
      for (const r of rows) {
        const seq = Number(r.seq);
        if (seq <= s.cursor) continue;
        s.cursor = seq;
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

  const api: PgKV = {
    async get(key) {
      const row = await getRow(key);
      if (!fresh(row)) {
        if (row) await del(key);
        return undefined;
      }
      return JSON.parse(row!.v);
    },
    async set(key, value, opts) {
      const expires = opts?.ttl != null ? now() + opts.ttl : null;
      await setRaw(key, JSON.stringify(value ?? null), expires);
    },
    async setNX(key, value, opts) {
      const expires = opts?.ttl != null ? now() + opts.ttl : null;
      // Atomic: insert if absent, OR overwrite only when the existing key is EXPIRED.
      // RETURNING yields a row iff we set it (insert / expired-replace) — no read-then-
      // write race, so exactly one of N racing callers wins the lock.
      const r = await q(
        `INSERT INTO _kv (ns, k, v, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at
           WHERE _kv.expires_at IS NOT NULL AND _kv.expires_at <= ?
         RETURNING 1`,
        [ns, key, JSON.stringify(value ?? null), expires, now()],
      );
      return r.rows.length > 0;
    },
    async has(key) {
      return (await api.get(key)) !== undefined;
    },
    async delete(key) {
      return del(key);
    },
    async incr(key, by = 1) {
      // Atomic upsert: create with `by`; add `by` to a live key; reset an EXPIRED key to
      // `by` (clearing its expiry). Done in one statement, so concurrent incrs don't lose
      // updates the way a read-modify-write under READ COMMITTED would.
      try {
        const r = await q(
          `INSERT INTO _kv (ns, k, v, expires_at) VALUES (?, ?, ?, NULL)
           ON CONFLICT (ns, k) DO UPDATE SET
             v = (CASE WHEN _kv.expires_at IS NOT NULL AND _kv.expires_at <= ?
                       THEN ?::numeric ELSE ((_kv.v)::numeric + ?::numeric) END)::text,
             expires_at = CASE WHEN _kv.expires_at IS NOT NULL AND _kv.expires_at <= ?
                               THEN NULL ELSE _kv.expires_at END
           RETURNING (v)::numeric AS n`,
          [ns, key, JSON.stringify(by), now(), by, by, now()],
        );
        return Number(r.rows[0].n);
      } catch (e: any) {
        if (/invalid input syntax|numeric/i.test(String(e?.message)))
          throw new Error(`kv.incr: value at "${key}" is not a number`);
        throw e;
      }
    },
    async decr(key, by = 1) {
      return api.incr(key, -by);
    },
    async mget(keys) {
      return Promise.all(keys.map((k) => api.get(k)));
    },
    async keys(prefix) {
      const t = now();
      const rows = (
        prefix !== undefined
          ? await q(
              `SELECT k, expires_at FROM _kv WHERE ns = ? AND k LIKE ? ESCAPE '\\'`,
              [ns, prefix.replace(/[%_\\]/g, "\\$&") + "%"],
            )
          : await q(`SELECT k, expires_at FROM _kv WHERE ns = ?`, [ns])
      ).rows as Array<{ k: string; expires_at: any }>;
      return rows
        .filter((r) => r.expires_at == null || Number(r.expires_at) > t)
        .map((r) => r.k);
    },
    async expire(key, ttl) {
      const row = await getRow(key);
      if (!fresh(row)) return false;
      await q(`UPDATE _kv SET expires_at = ? WHERE ns = ? AND k = ?`, [
        now() + ttl,
        ns,
        key,
      ]);
      return true;
    },
    async ttl(key) {
      const row = await getRow(key);
      if (!fresh(row)) return -2;
      if (row!.expires_at == null) return -1;
      return Number(row!.expires_at) - now();
    },
    async flush() {
      await q(`DELETE FROM _kv WHERE ns = ?`, [ns]);
    },
    async size() {
      return Number(
        (
          await q(
            `SELECT COUNT(*) AS n FROM _kv WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?)`,
            [ns, now()],
          )
        ).rows[0].n,
      );
    },

    // ── sorted sets ──────────────────────────────────────────────────────────
    async zadd(key, score, member) {
      if (typeof score !== "number" || Number.isNaN(score))
        throw new Error(`kv.zadd: score must be a number, got ${score}`);
      await q(
        `INSERT INTO _monlite_kv_zset (ns, k, member, score) VALUES (?, ?, ?, ?)
         ON CONFLICT(ns, k, member) DO UPDATE SET score = excluded.score`,
        [ns, key, member, score],
      );
    },
    async zincrby(key, delta, member) {
      if (typeof delta !== "number" || Number.isNaN(delta))
        throw new Error(`kv.zincrby: delta must be a number, got ${delta}`);
      // Atomic increment via the UPSERT itself (existing.score + delta) — no
      // read-then-write race under concurrent updates to the same member.
      const r = await q(
        `INSERT INTO _monlite_kv_zset (ns, k, member, score) VALUES (?, ?, ?, ?)
         ON CONFLICT(ns, k, member) DO UPDATE
           SET score = _monlite_kv_zset.score + ?
         RETURNING score`,
        [ns, key, member, delta, delta],
      );
      return Number(r.rows[0].score);
    },
    async zscore(key, member) {
      const row = (
        await q(
          `SELECT score FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
          [ns, key, member],
        )
      ).rows[0] as { score: number } | undefined;
      return row?.score;
    },
    async zrem(key, member) {
      return (
        (
          await q(
            `DELETE FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
            [ns, key, member],
          )
        ).changes > 0
      );
    },
    async zcard(key) {
      return Number(
        (
          await q(
            `SELECT COUNT(*) AS n FROM _monlite_kv_zset WHERE ns = ? AND k = ?`,
            [ns, key],
          )
        ).rows[0].n,
      );
    },
    async zrank(key, member, opts) {
      const row = (
        await q(
          `SELECT score FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?`,
          [ns, key, member],
        )
      ).rows[0] as { score: number } | undefined;
      if (!row) return undefined;
      const cmp = opts?.rev
        ? `score > ? OR (score = ? AND member > ?)`
        : `score < ? OR (score = ? AND member < ?)`;
      return Number(
        (
          await q(
            `SELECT COUNT(*) AS n FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND (${cmp})`,
            [ns, key, row.score, row.score, member],
          )
        ).rows[0].n,
      );
    },
    async zrange(key, start, stop, opts) {
      start = Math.trunc(start);
      stop = Math.trunc(stop);
      const card = await api.zcard(key);
      let lo = start < 0 ? card + start : start;
      let hi = stop < 0 ? card + stop : stop;
      if (lo < 0) lo = 0;
      if (hi >= card) hi = card - 1;
      if (card === 0 || lo > hi) return [];
      const dir = opts?.rev ? "DESC" : "ASC";
      const rows = (
        await q(
          `SELECT member, score FROM _monlite_kv_zset WHERE ns = ? AND k = ?
           ORDER BY score ${dir}, member ${dir} LIMIT ? OFFSET ?`,
          [ns, key, hi - lo + 1, lo],
        )
      ).rows as Array<{ member: string; score: number }>;
      return opts?.withScores ? rows : rows.map((r) => r.member);
    },
    async zrangeByScore(key, min, max, opts) {
      const rows = (
        await q(
          `SELECT member, score FROM _monlite_kv_zset WHERE ns = ? AND k = ?
           AND score >= ? AND score <= ? ORDER BY score ASC, member ASC`,
          [ns, key, min, max],
        )
      ).rows as Array<{ member: string; score: number }>;
      return opts?.withScores ? rows : rows.map((r) => r.member);
    },

    async publish(channel, message) {
      const ts = now();
      await q(
        `INSERT INTO _monlite_kv_pubsub (ns, channel, payload, ts) VALUES (?, ?, ?, ?)`,
        [ns, channel, JSON.stringify(message ?? null), ts],
      );
      await q(`DELETE FROM _monlite_kv_pubsub WHERE ns = ? AND ts < ?`, [
        ns,
        ts - 30_000,
      ]);
      await drainPubsub();
      let n = 0;
      for (const s of subs) if (s.channel === channel) n++;
      return n;
    },
    subscribe(channel, cb) {
      // cursor = Infinity blocks delivery until the high-water seq is snapshotted —
      // so a new subscriber never replays messages published before it (no replay),
      // and it can't race delivery while the async snapshot is in flight.
      const sub: Sub = { channel, cb, cursor: Infinity };
      subs.add(sub);
      void psMaxSeq().then((s) => {
        sub.cursor = s;
      });
      if (!psTask)
        psTask = db.heartbeat.every(pubsubPollMs, () => void drainPubsub());
      return () => {
        subs.delete(sub);
        if (subs.size === 0 && psTask) {
          psTask.cancel();
          psTask = undefined;
        }
      };
    },
    stop() {
      if (psTask) {
        psTask.cancel();
        psTask = undefined;
      }
    },
  };

  return api;
}
