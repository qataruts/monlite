import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite, type MonliteOptions } from "../src/index";
import { openDb } from "./helper";

const driver = process.env.MONLITE_DRIVER as
  | MonliteOptions["driver"]
  | undefined;
const dbs: Monlite[] = [];
const dirs: string[] = [];
function fileDb(path: string): Monlite {
  const db = createDb(path, {
    changefeed: true,
    ...(driver ? { driver } : {}),
  });
  dbs.push(db);
  return db;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("P0 — change feed (db.changes / changesSince / currentSeq)", () => {
  it("is off by default and throws a clear error", () => {
    const db = openDb();
    expect(() => db.currentSeq()).toThrow(/changefeed/i);
    expect(() => db.changesSince(undefined, 0)).toThrow(/changefeed/i);
  });

  it("records every change in order (upsert, update, delete)", async () => {
    const db = openDb({ changefeed: true });
    const c = db.collection("orders");
    await c.create({ data: { _id: "a", n: 1 } });
    await c.update({ where: { _id: "a" }, data: { $set: { n: 2 } } });
    await c.delete({ where: { _id: "a" } });
    const evs = db.changesSince(undefined, 0);
    expect(evs.map((e) => e.op)).toEqual(["upsert", "upsert", "delete"]);
    expect(evs.every((e) => e.collection === "orders" && e.id === "a")).toBe(
      true,
    );
    expect(db.currentSeq()).toBe(3);
  });

  it("filters by collection and resumes from a seq", async () => {
    const db = openDb({ changefeed: true });
    await db.collection("a").create({ data: { _id: "1" } });
    await db.collection("b").create({ data: { _id: "2" } });
    await db.collection("a").delete({ where: { _id: "1" } });
    expect(db.changesSince("a", 0).map((e) => e.op)).toEqual([
      "upsert",
      "delete",
    ]);
    expect(db.changesSince("b", 0).length).toBe(1);
    // resume strictly after seq 2 → only the delete (seq 3)
    expect(db.changesSince(undefined, 2)).toMatchObject([
      { seq: 3, op: "delete" },
    ]);
  });

  it("`sync: true` implies the change feed", async () => {
    const db = openDb({ sync: true });
    await db.collection("y").create({ data: { _id: "z" } });
    expect(db.changesSince(undefined, 0).length).toBe(1);
  });

  it("streams cross-process writes and stops on abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-"));
    dirs.push(dir);
    const file = join(dir, "cf.db");
    const writer = fileDb(file);
    const reader = fileDb(file); // separate connection = another process
    await writer.collection("x").create({ data: { _id: "1" } });

    const ac = new AbortController();
    const got: string[] = [];
    const stream = (async () => {
      for await (const ev of reader.changes("x", {
        since: 0,
        pollMs: 20,
        signal: ac.signal,
      }))
        got.push(ev.id);
    })();
    await sleep(60);
    await writer.collection("x").create({ data: { _id: "2" } }); // write from the OTHER conn
    await sleep(150);
    ac.abort();
    await stream;
    expect(got).toEqual(["1", "2"]);
  });

  it("compaction: changefeed-only drops old (keeps newest N); sync protects unpushed", async () => {
    const cf = openDb({ changefeed: true });
    for (let i = 0; i < 10; i++)
      await cf.collection("k").create({ data: { _id: String(i) } });
    expect(cf.compactChanges({ keepLast: 3 })).toBe(7);
    expect(cf.changesSince(undefined, 0).map((e) => e.seq)).toEqual([8, 9, 10]);

    const sy = openDb({ sync: true });
    for (let i = 0; i < 10; i++)
      await sy.collection("k").create({ data: { _id: String(i) } });
    expect(sy.compactChanges({ keepLast: 3 })).toBe(0); // unpushed → protected
  });
});

describe("P3 — cross-process reactivity (watch backed by the feed)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a watcher sees writes from ANOTHER connection to the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p3-"));
    dirs.push(dir);
    const file = join(dir, "p3.db");
    const A = createDb(file, {
      changefeed: true,
      reactorPollMs: 30,
      ...(driver ? { driver } : {}),
    });
    const B = createDb(file, {
      changefeed: true,
      reactorPollMs: 30,
      ...(driver ? { driver } : {}),
    });
    dbs.push(A, B);
    const events: any[] = [];
    A.collection("orders").watch({ where: { status: "open" } }, (e) =>
      events.push(e),
    );
    await wait(20);
    const base = events.length;
    await B.collection("orders").create({
      data: { _id: "o1", status: "open" },
    });
    await wait(120);
    expect(events.length).toBe(base + 1);
    expect(events.at(-1).added.map((x: any) => x._id)).toEqual(["o1"]);
    await B.collection("orders").update({
      where: { _id: "o1" },
      data: { $set: { status: "closed" } },
    });
    await wait(120);
    expect(events.at(-1).removed.map((x: any) => x._id)).toEqual(["o1"]);
  });

  it("changefeed-on same-process watch is still correct", async () => {
    const db = openDb({ changefeed: true });
    const c = db.collection("c");
    const evs: any[] = [];
    c.watch({ where: { active: true } }, (e) => evs.push(e));
    await wait(15);
    const d = await c.create({ data: { active: true, n: 1 } });
    await wait(15);
    await c.update({ where: { _id: d._id }, data: { $set: { n: 2 } } });
    await wait(15);
    await c.delete({ where: { _id: d._id } });
    await wait(15);
    expect(evs.map((e) => e.type)).toEqual([
      "init",
      "change",
      "change",
      "change",
    ]);
    expect(evs[1].added.length).toBe(1);
    expect(evs[3].removed.length).toBe(1);
  });
});
