import { EventEmitter } from "node:events";
import type { Monlite, HeartbeatTask } from "@monlite/core";

export interface CronOptions {
  /** How often the scheduler checks for due jobs (ms). Default 1000. */
  checkInterval?: number;
}

/** Per-schedule options. */
export interface ScheduleOptions {
  /**
   * IANA time zone (e.g. `"Europe/Istanbul"`) the cron expression is evaluated
   * in, DST included. Default: the server's local time.
   */
  tz?: string;
  /**
   * Add a random delay of up to this many ms to each firing — spreads a
   * thundering herd of schedules that would otherwise fire at the same instant.
   * Default `0`.
   */
  jitter?: number;
}

export type CronHandler = () => void | Promise<void>;

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : parseInt(stepPart, 10);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      // `N/step` means "from N up to max, every step" (e.g. `5/15` → 5,20,35,50);
      // a bare `N` (no step) means exactly {N}.
      lo = parseInt(rangePart, 10);
      hi = stepPart === undefined ? lo : max;
    }
    if (
      Number.isNaN(lo) ||
      Number.isNaN(hi) ||
      Number.isNaN(step) ||
      step < 1 ||
      lo < min ||
      hi > max ||
      lo > hi
    ) {
      throw new Error(`Invalid cron field "${field}" (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a standard 5-field cron expression (`min hour dom month dow`). */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields, got ${parts.length}: "${expr}"`,
    );
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** Wall-clock fields `c` matches against — day-of-month / day-of-week handled per POSIX. */
interface WallParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dow: number;
}

function partsMatch(c: ParsedCron, p: WallParts): boolean {
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month))
    return false;
  const dom = c.dom.has(p.day);
  const dow = c.dow.has(p.dow);
  // POSIX: when both day-of-month and day-of-week are restricted, either matches.
  return c.domRestricted && c.dowRestricted ? dom || dow : dom && dow;
}

const localParts = (d: Date): WallParts => ({
  minute: d.getMinutes(),
  hour: d.getHours(),
  day: d.getDate(),
  month: d.getMonth() + 1,
  dow: d.getDay(),
});

const DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const tzFmtCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = tzFmtCache.get(tz);
  if (!f) {
    // Throws "Invalid time zone" on a bad tz — surfaces a clear error to the caller.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    tzFmtCache.set(tz, f);
  }
  return f;
}

/** The wall-clock fields of instant `d` as seen in IANA time zone `tz`. */
function tzParts(d: Date, tz: string): WallParts {
  const map: Record<string, string> = {};
  for (const part of tzFormatter(tz).formatToParts(d))
    map[part.type] = part.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // some engines render midnight as "24"
  return {
    minute: parseInt(map.minute, 10),
    hour,
    day: parseInt(map.day, 10),
    month: parseInt(map.month, 10),
    dow: DOW[map.weekday] ?? 0,
  };
}

/**
 * The next time (strictly after `from`) a cron expression fires. Evaluated in
 * local time by default, or in `opts.tz` (an IANA zone like `"Europe/Istanbul"`)
 * — handling that zone's DST transitions.
 */
export function nextCronRun(
  expr: string | ParsedCron,
  from: Date = new Date(),
  opts: { tz?: string } = {},
): Date {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const tz = opts.tz;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Search up to ~5 years so a leap-day-only schedule (`* * 29 2 *`) still resolves
  // across the 4-year gap instead of throwing. Local iteration uses Date arithmetic
  // (skips non-existent days / handles DST natively); the tz path advances absolute
  // time by a minute and reads the zone's wall clock (DST handled by `Intl`).
  for (let i = 0; i < 5 * 366 * 24 * 60; i++) {
    if (partsMatch(c, tz ? tzParts(d, tz) : localParts(d))) return d;
    if (tz) d.setTime(d.getTime() + 60_000);
    else d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`Could not compute next run for cron "${expr}"`);
}

const ensured = new WeakSet<object>();
const nowMs = () => Date.now();

/**
 * A persisted cron scheduler. Schedules survive restarts (next-run is stored),
 * and firing is atomic so multiple processes won't double-run an occurrence.
 * Compose with a queue for durable work: `cron.schedule(n, expr, () => queue.add(...))`.
 * Emits `"error"` (err, name) if a handler throws.
 */
export class Cron extends EventEmitter {
  private readonly driver: Monlite["driver"];
  private readonly heartbeat: Monlite["heartbeat"];
  private readonly checkInterval: number;
  private readonly handlers = new Map<
    string,
    { c: ParsedCron; fn: CronHandler; tz?: string; jitter?: number }
  >();
  private task: HeartbeatTask | undefined;

  constructor(db: Monlite, opts: CronOptions = {}) {
    super();
    this.driver = db.driver;
    this.heartbeat = db.heartbeat;
    this.checkInterval = opts.checkInterval ?? 1000;
    if (!ensured.has(db)) {
      this.driver.exec(
        `CREATE TABLE IF NOT EXISTS _schedules (
          name TEXT PRIMARY KEY, cron TEXT NOT NULL,
          next_run INTEGER NOT NULL, last_run INTEGER
        )`,
      );
      ensured.add(db);
    }
  }

  /** Compute the next firing (epoch ms) for a schedule, applying tz + jitter. */
  private computeNext(
    c: ParsedCron,
    from: Date,
    tz?: string,
    jitter?: number,
  ): number {
    const base = nextCronRun(c, from, { tz }).getTime();
    return jitter && jitter > 0
      ? base + Math.floor(Math.random() * jitter)
      : base;
  }

  /** Register (or update) a schedule and start the scheduler. */
  schedule(
    name: string,
    expr: string,
    handler: CronHandler,
    opts: ScheduleOptions = {},
  ): void {
    const c = parseCron(expr);
    const { tz, jitter } = opts;
    const existing = this.driver
      .prepare(`SELECT next_run, cron FROM _schedules WHERE name = ?`)
      .get(name) as { next_run: number; cron: string } | undefined;
    // Keep the stored next_run only when the expression is unchanged (so a restart
    // doesn't reset timing); if the expr changed, recompute so the new schedule
    // takes effect immediately instead of waiting out the old next_run.
    const next =
      existing && existing.cron === expr
        ? existing.next_run
        : this.computeNext(c, new Date(), tz, jitter);
    this.driver
      .prepare(
        `INSERT INTO _schedules (name, cron, next_run, last_run) VALUES (?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET cron = excluded.cron, next_run = excluded.next_run`,
      )
      .run(name, expr, next);
    this.handlers.set(name, { c, fn: handler, tz, jitter });
    // One poll on the database's shared heartbeat (coalesced with the reactor,
    // kv pub/sub and queue) instead of a dedicated interval.
    if (!this.task) {
      this.task = this.heartbeat.every(this.checkInterval, () => this.tick());
    }
  }

  /** Remove a schedule. */
  unschedule(name: string): void {
    this.handlers.delete(name);
    this.driver.prepare(`DELETE FROM _schedules WHERE name = ?`).run(name);
  }

  /** The next scheduled run (epoch ms) for a registered schedule. */
  next(name: string): number | undefined {
    const row = this.driver
      .prepare(`SELECT next_run FROM _schedules WHERE name = ?`)
      .get(name) as { next_run: number } | undefined;
    return row?.next_run;
  }

  /** @internal — exposed for tests; runs one scheduling pass. */
  tick(): void {
    const t = nowMs();
    for (const [name, reg] of this.handlers) {
      const row = this.driver
        .prepare(`SELECT next_run FROM _schedules WHERE name = ?`)
        .get(name) as { next_run: number } | undefined;
      if (!row || row.next_run > t) continue;
      const next = this.computeNext(reg.c, new Date(t), reg.tz, reg.jitter);
      // Atomic claim: only the process that flips next_run gets to fire.
      const claimed =
        this.driver
          .prepare(
            `UPDATE _schedules SET last_run = ?, next_run = ? WHERE name = ? AND next_run <= ?`,
          )
          .run(t, next, name, t).changes > 0;
      if (claimed) {
        Promise.resolve()
          .then(() => reg.fn())
          .catch((err) => this.emit("error", err, name));
      }
    }
  }

  /** Stop the scheduler (schedules remain persisted). */
  stop(): void {
    if (this.task) this.task.cancel();
    this.task = undefined;
  }
}

/** Create a cron scheduler over a monlite database. */
export function createCron(db: Monlite, opts?: CronOptions): Cron {
  return new Cron(db, opts);
}
