import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { createCron, nextCronRun, parseCron, type Cron } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dbs: Monlite[] = [];
const crons: Cron[] = [];
function open(): Monlite {
  const d = createDb(":memory:", driver ? { driver } : {});
  dbs.push(d);
  return d;
}
function makeCron(...args: Parameters<typeof createCron>): Cron {
  const c = createCron(...args);
  crons.push(c);
  return c;
}
const waitFor = async (fn: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error("waitFor timed out");
};
afterEach(async () => {
  while (crons.length) crons.pop()!.stop();
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("cron parser / nextCronRun", () => {
  it("computes the next minute", () => {
    const from = new Date("2026-01-01T10:00:30");
    expect(nextCronRun("* * * * *", from).toISOString()).toBe(
      new Date("2026-01-01T10:01:00").toISOString(),
    );
  });

  it("handles step, range, list and specific times", () => {
    const from = new Date("2026-01-01T10:07:00");
    expect(nextCronRun("*/15 * * * *", from).getMinutes()).toBe(15);
    expect(nextCronRun("0 0 * * *", from).toISOString()).toBe(
      new Date("2026-01-02T00:00:00").toISOString(),
    );
    // 9am on Mondays — 2026-01-01 is a Thursday, next Monday is the 5th.
    const mon = nextCronRun("0 9 * * 1", from);
    expect(mon.getDay()).toBe(1);
    expect(mon.getHours()).toBe(9);
    expect(mon.getDate()).toBe(5);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(); // 4 fields
    expect(() => parseCron("99 * * * *")).toThrow(); // minute out of range
    expect(() => parseCron("a * * * *")).toThrow(); // non-numeric
  });
});

describe("@monlite/cron scheduler", () => {
  it("fires a due schedule exactly once, then reschedules forward", async () => {
    const db = open();
    const cron = makeCron(db, { checkInterval: 10 });
    let runs = 0;
    cron.schedule("tick", "*/5 * * * *", () => {
      runs++;
    });
    // Force it due now (instead of waiting minutes).
    db.driver
      .prepare(`UPDATE _schedules SET next_run = ? WHERE name = ?`)
      .run(Date.now() - 1, "tick");
    await waitFor(() => runs === 1);
    await sleep(40); // ensure it doesn't double-fire
    expect(runs).toBe(1);
    expect(cron.next("tick")!).toBeGreaterThan(Date.now());
  });

  it("composes with a callback (durable work pattern) and survives restart", async () => {
    const db = open();
    const cron1 = makeCron(db, { checkInterval: 10 });
    const enqueued: number[] = [];
    cron1.schedule("job", "0 * * * *", () => void enqueued.push(1));
    const firstNext = cron1.next("job");
    cron1.stop();

    // A new Cron over the same db keeps the persisted next_run.
    const cron2 = makeCron(db, { checkInterval: 10 });
    cron2.schedule("job", "0 * * * *", () => void enqueued.push(1));
    expect(cron2.next("job")).toBe(firstNext);

    db.driver
      .prepare(`UPDATE _schedules SET next_run = ? WHERE name = ?`)
      .run(Date.now() - 1, "job");
    await waitFor(() => enqueued.length === 1);
  });
});
