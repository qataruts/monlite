// @monlite/cron on the Postgres engine: PgCron — persisted _schedules, atomic cross-process claim.
// Skips cleanly without a reachable Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "@monlite/postgres";
import { createPgCron } from "../src/index";

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

let available = false;
try {
  const d = postgres(URL);
  await d.query("SELECT 1");
  await d.close();
  available = true;
} catch {
  available = false;
}

(available ? describe : describe.skip)("@monlite/cron on Postgres", () => {
  let db: any;
  beforeAll(async () => {
    db = createDb(URL);
    await db.asyncDriver.exec(`DROP TABLE IF EXISTS _schedules CASCADE`);
  });
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it("persists a schedule and fires the handler on a due tick", async () => {
    const cron = createPgCron(db);
    let fired = 0;
    // every minute; we drive tick() manually rather than wait on wall-clock
    await cron.schedule("beat", "* * * * *", () => {
      fired++;
    });
    expect(typeof (await cron.next("beat"))).toBe("number");

    // not yet due → no fire
    await cron.tick();
    expect(fired).toBe(0);

    // force it due, then tick → fires exactly once (atomic claim)
    await db.asyncDriver.exec(`UPDATE _schedules SET next_run = 1 WHERE name = 'beat'`);
    await cron.tick();
    await new Promise((r) => setTimeout(r, 50)); // handler runs on a microtask
    expect(fired).toBe(1);

    // a second immediate tick does NOT double-fire (next_run was advanced)
    await cron.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(1);

    await cron.unschedule("beat");
    expect(await cron.next("beat")).toBeUndefined();
    cron.stop();
  });
});
