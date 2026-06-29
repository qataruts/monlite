// Exercises the REAL @monlite/postgres package (createDb + the PgDriver) against a live
// Postgres. Skips cleanly when none is reachable (CI without a PG service).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "../src/index";

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

(available ? describe : describe.skip)("@monlite/postgres", () => {
  let db: any;
  beforeAll(async () => {
    db = createDb(URL);
    await db.asyncDriver.exec(`DROP TABLE IF EXISTS t CASCADE`);
  });
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it("createDb opens a Postgres-backed monlite", () => {
    expect(db.asyncDriver?.name).toBe("postgres");
  });

  it("runs the monlite collection API on Postgres", async () => {
    const t = db.collection("t");
    await t.createMany({
      data: [
        { _id: "1", n: 1, tags: ["a"] },
        { _id: "2", n: 5, tags: ["a", "b"] },
        { _id: "3", n: 9, tags: ["b"] },
      ],
    });
    expect(await t.count()).toBe(3);
    expect(await t.count({ where: { n: { gte: 5 } } })).toBe(2);
    expect((await t.findMany({ where: { n: { gte: 5 } }, orderBy: { n: "desc" } })).map((d: any) => d._id)).toEqual(["3", "2"]);
    expect((await t.findMany({ where: { tags: { has: "b" } } })).map((d: any) => d._id).sort()).toEqual(["2", "3"]);
    await t.update({ where: { _id: "1" }, data: { $inc: { n: 100 } } });
    expect((await t.findById("1"))?.n).toBe(101);
    await t.delete({ where: { _id: "2" } });
    expect(await t.count()).toBe(2);
  });

  it("transactions roll back on error", async () => {
    const t = db.collection("t");
    const before = await t.count();
    await expect(
      db.asyncDriver.transactionAsync(async () => {
        await t.create({ data: { _id: "tx", n: 0 } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await t.count()).toBe(before);
    expect(await t.findById("tx")).toBeNull();
  });

  it("watch() delivers realtime events via LISTEN/NOTIFY", async () => {
    await db.asyncDriver.exec(`DROP TABLE IF EXISTS w CASCADE`);
    const w = db.collection("w");
    const events: any[] = [];
    const handle = w.watch({ orderBy: { n: "asc" } }, (e: any) => events.push(e));

    const waitFor = async (pred: () => boolean, ms = 4000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms)
          throw new Error("timeout; saw " + JSON.stringify(events.map((e) => e.type)));
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    // init fires once LISTEN + the trigger are in place
    await waitFor(() => events.some((e) => e.type === "init"));

    // insert → "added" (the trigger NOTIFYs, the listener re-queries + diffs)
    await w.create({ data: { _id: "1", n: 1 } });
    await waitFor(() => events.some((e) => e.added?.some((d: any) => d._id === "1")));

    // update → "changed"
    await w.update({ where: { _id: "1" }, data: { $set: { n: 2 } } });
    await waitFor(() =>
      events.some((e) => e.changed?.some((d: any) => d._id === "1")),
    );

    // delete → "removed"
    await w.delete({ where: { _id: "1" } });
    await waitFor(() =>
      events.some((e) => e.removed?.some((d: any) => d._id === "1")),
    );

    expect(handle.results).toEqual([]); // empty again after the delete
    handle.stop();
  });
});
