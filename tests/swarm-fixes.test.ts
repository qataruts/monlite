import { describe, it, expect, afterEach } from "vitest";
import { getEventListeners } from "node:events";
import { type Monlite } from "../src/index";
import { openDb } from "./helper";

const dbs: Monlite[] = [];
const open = (opts = {}) => {
  const db = openDb(opts);
  dbs.push(db);
  return db;
};
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});
const tick = () => new Promise((r) => setTimeout(r, 15));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("swarm fixes — reactivity correctness", () => {
  it("#1: a committed write after a rolled-back transactionAsync is NOT missed (changefeed)", async () => {
    const db = open({ changefeed: true, reactorPollMs: 15 });
    const c = db.collection("orders");
    const ev: any[] = [];
    c.watch({ where: { status: "open" } }, (e) => ev.push(e));
    await tick();
    await db
      .transactionAsync(async () => {
        await c.create({ data: { _id: "ghost", status: "open" } });
        await Promise.resolve();
        throw new Error("boom");
      })
      .catch(() => {});
    await wait(50);
    await c.create({ data: { _id: "real", status: "open" } });
    await wait(80);
    const seen = ev.some(
      (e) =>
        e.results.some((d: any) => d._id === "real") ||
        e.added.some((d: any) => d._id === "real"),
    );
    expect(seen).toBe(true);
  });

  it("#6: a rolled-back transactionAsync write fires NO phantom event (default path)", async () => {
    const db = open();
    const c = db.collection("c");
    const ev: any[] = [];
    c.watch({ where: { active: true } }, (e) => ev.push(e));
    await tick();
    await db
      .transactionAsync(async () => {
        await c.create({ data: { _id: "y", active: true } });
        await Promise.resolve();
        throw new Error("no");
      })
      .catch(() => {});
    await wait(40);
    expect(ev[ev.length - 1].results.some((d: any) => d._id === "y")).toBe(
      false,
    );
  });

  it("#2: watch({ select }) omitting _id keeps added/changed deltas correct", async () => {
    const c = open().collection("c");
    await c.create({ data: { _id: "a", status: "open", title: "T1" } });
    const ev: any[] = [];
    c.watch({ where: { status: "open" }, select: { title: true } }, (e) =>
      ev.push(e),
    );
    await tick();
    await c.create({ data: { _id: "b", status: "open", title: "T2" } });
    await tick();
    expect(ev.at(-1).added.length).toBe(1);
    expect(ev.at(-1).results.every((d: any) => d._id === undefined)).toBe(true); // projected
    await c.update({ where: { _id: "a" }, data: { $set: { title: "T1b" } } });
    await tick();
    expect(ev.at(-1).changed.length).toBe(1);
  });

  it("#3: field-scoped watch fires even when select omits the watched field", async () => {
    const c = open().collection("c");
    const d = await c.create({ data: { status: "open", title: "t" } });
    let fires = 0;
    c.watch({ fields: ["status"], select: { title: true } }, () => fires++);
    await tick();
    const base = fires;
    await c.update({
      where: { _id: d._id },
      data: { $set: { status: "closed" } },
    });
    await tick();
    expect(fires).toBe(base + 1);
  });

  it("#7: a later watcher does NOT replay writes from a no-watcher window", async () => {
    const db = open({ changefeed: true, reactorPollMs: 20 });
    const c = db.collection("orders");
    c.watch({ where: { status: "open" } }, () => {}).stop();
    await tick();
    await c.create({ data: { _id: "old1", status: "open" } });
    await c.create({ data: { _id: "old2", status: "open" } });
    await wait(40);
    const ev: any[] = [];
    c.watch({ where: { status: "open" } }, (e) => ev.push(e));
    await wait(80);
    expect(ev[0].results.map((d: any) => d._id).sort()).toEqual([
      "old1",
      "old2",
    ]);
    expect(ev.length).toBe(1); // init only, no spurious replay
  });

  it("#8: changes() does not leak an abort listener per poll", async () => {
    const db = open({ changefeed: true });
    await db.collection("x").create({ data: { _id: "1" } });
    const ac = new AbortController();
    const stream = (async () => {
      for await (const _ of db.changes("x", {
        since: 0,
        pollMs: 2,
        signal: ac.signal,
      }))
        void _;
    })();
    await wait(120);
    expect(getEventListeners(ac.signal, "abort").length).toBeLessThanOrEqual(2);
    ac.abort();
    await stream;
  });
});
