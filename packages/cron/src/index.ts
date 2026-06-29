import { EventEmitter } from "node:events";
import type { Monlite } from "@monlite/core";

export interface CronOptions {
  /** How often the scheduler checks for due jobs (ms). Default 1000. */
  checkInterval?: number;
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

function dayMatches(c: ParsedCron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay()); // 0 = Sunday
  // POSIX: when both day-of-month and day-of-week are restricted, either matches.
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  return dom && dow;
}

/** The next time (strictly after `from`, local time) a cron expression fires. */
export function nextCronRun(
  expr: string | ParsedCron,
  from: Date = new Date(),
): Date {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Search up to ~5 years so a leap-day-only schedule (`* * 29 2 *`) still resolves
  // across the 4-year gap instead of throwing. JS Date arithmetic below skips
  // non-existent days (Feb 29 in common years) and handles DST transitions natively.
  for (let i = 0; i < 5 * 366 * 24 * 60; i++) {
    if (
      c.minute.has(d.getMinutes()) &&
      c.hour.has(d.getHours()) &&
      c.month.has(d.getMonth() + 1) &&
      dayMatches(c, d)
    ) {
      return d;
    }
    d.setMinutes(d.getMinutes() + 1);
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
  private readonly checkInterval: number;
  private readonly handlers = new Map<
    string,
    { c: ParsedCron; fn: CronHandler }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(db: Monlite, opts: CronOptions = {}) {
    super();
    this.driver = db.driver;
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

  /** Register (or update) a schedule and start the scheduler. */
  schedule(name: string, expr: string, handler: CronHandler): void {
    const c = parseCron(expr);
    const existing = this.driver
      .prepare(`SELECT next_run, cron FROM _schedules WHERE name = ?`)
      .get(name) as { next_run: number; cron: string } | undefined;
    // Keep the stored next_run only when the expression is unchanged (so a restart
    // doesn't reset timing); if the expr changed, recompute so the new schedule
    // takes effect immediately instead of waiting out the old next_run.
    const next =
      existing && existing.cron === expr
        ? existing.next_run
        : nextCronRun(c).getTime();
    this.driver
      .prepare(
        `INSERT INTO _schedules (name, cron, next_run, last_run) VALUES (?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET cron = excluded.cron, next_run = excluded.next_run`,
      )
      .run(name, expr, next);
    this.handlers.set(name, { c, fn: handler });
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.checkInterval);
      this.timer.unref?.();
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
      const next = nextCronRun(reg.c, new Date(t)).getTime();
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
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Create a cron scheduler over a monlite database. */
export function createCron(db: Monlite, opts?: CronOptions): Cron {
  return new Cron(db, opts);
}
