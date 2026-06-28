import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite, type MonlitePlugin } from "../src/index";

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

// A plugin whose index step (afterWrite) throws for a specific id — stands in for
// e.g. @monlite/vector rejecting a wrong-dimension vector mid-batch.
const failOn = (badId: string): MonlitePlugin => ({
  name: "failing-index",
  afterWrite: (_db, { ids }) => {
    if (ids.includes(badId)) throw new Error("index fail");
  },
});

describe("write + plugin indexing is atomic", () => {
  it("create rolls the row back if afterWrite throws", async () => {
    const db = createDb(":memory:", { plugins: [failOn("bad")] });
    dbs.push(db);
    const c = db.collection("t");
    await expect(c.create({ data: { _id: "bad" } })).rejects.toThrow(/index fail/);
    expect(await c.count()).toBe(0); // nothing committed
  });

  it("createMany rolls the whole batch back on a mid-batch afterWrite failure", async () => {
    const db = createDb(":memory:", { plugins: [failOn("bad")] });
    dbs.push(db);
    const c = db.collection("t");
    await expect(
      c.createMany({ data: [{ _id: "a" }, { _id: "bad" }, { _id: "c" }] }),
    ).rejects.toThrow(/index fail/);
    expect(await c.count()).toBe(0); // no partial commit
  });

  it("a clean batch still commits + indexes", async () => {
    const db = createDb(":memory:", { plugins: [failOn("never")] });
    dbs.push(db);
    const c = db.collection("t");
    await c.createMany({ data: [{ _id: "a" }, { _id: "b" }] });
    expect(await c.count()).toBe(2);
  });
});

// A plugin that throws on demand, so we can seed cleanly then arm it before a mutation.
function armable() {
  const state = { armed: false };
  const plugin: MonlitePlugin = {
    name: "armable-index",
    afterWrite: () => {
      if (state.armed) throw new Error("index fail");
    },
  };
  return { plugin, state };
}

describe("mutation + delete paths index atomically too", () => {
  it("update / delete / findOneAndUpdate / upsert / bulkWrite roll back on a failing afterWrite", async () => {
    const { plugin, state } = armable();
    const db = createDb(":memory:", { plugins: [plugin] });
    dbs.push(db);
    const c = db.collection("t");
    await c.create({ data: { _id: "x", v: 0 } });
    state.armed = true;

    await expect(c.update({ where: { _id: "x" }, data: { $set: { v: 1 } } })).rejects.toThrow(/index fail/);
    expect((await c.findById("x"))?.v).toBe(0);

    await expect(
      c.findOneAndUpdate({ where: { _id: "x" }, data: { $set: { v: 2 } } }),
    ).rejects.toThrow(/index fail/);
    expect((await c.findById("x"))?.v).toBe(0);

    await expect(
      c.upsert({ where: { _id: "x" }, create: { _id: "x", v: 9 }, update: { $set: { v: 3 } } }),
    ).rejects.toThrow(/index fail/);
    expect((await c.findById("x"))?.v).toBe(0);

    await expect(
      c.bulkWrite([{ updateOne: { where: { _id: "x" }, data: { $set: { v: 5 } } } }]),
    ).rejects.toThrow(/index fail/);
    expect((await c.findById("x"))?.v).toBe(0);

    await expect(c.delete({ where: { _id: "x" } })).rejects.toThrow(/index fail/);
    expect(await c.count()).toBe(1); // still present
  });

  it("purgeExpired rolls back on a failing afterWrite", async () => {
    const { plugin, state } = armable();
    const db = createDb(":memory:", { plugins: [plugin] });
    dbs.push(db);
    const c = db.collection("t", { ttl: { field: "exp", seconds: 0 } });
    await c.create({ data: { _id: "x", exp: Date.now() - 100_000 } });
    state.armed = true;
    await expect(c.purgeExpired()).rejects.toThrow(/index fail/);
    expect(await c.count()).toBe(1); // not purged
  });
});

describe("applyRemoteWrite (sync ingest) respects the write guard", () => {
  it("is rejected when issued during an in-flight transactionAsync", async () => {
    const db = createDb(":memory:");
    dbs.push(db);
    const c = db.collection("t");
    await c.create({ data: { _id: "seed" } });
    const tx = db.transactionAsync(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(() =>
      (c as any).applyRemoteWrite("upsert", "r1", { v: 1 }, Date.now()),
    ).toThrow(/transactionAsync/);
    await tx;
    expect(await c.findById("r1")).toBeNull(); // not applied
  });
});

describe("sync ingest indexes atomically too", () => {
  it("applyRemoteWrite upsert + delete roll back when afterWrite throws", async () => {
    const { plugin, state } = armable();
    const db = createDb(":memory:", { plugins: [plugin] });
    dbs.push(db);
    const c = db.collection("t");
    await c.create({ data: { _id: "x", v: 0 } });
    state.armed = true;
    // a remote upsert that fails to index must NOT change the row
    expect(() => (c as any).applyRemoteWrite("upsert", "x", { v: 99 }, Date.now())).toThrow(/index fail/);
    expect((await c.findById("x"))?.v).toBe(0);
    // a remote delete that fails to index must NOT delete
    expect(() => (c as any).applyRemoteWrite("delete", "x", undefined, Date.now())).toThrow(/index fail/);
    expect(await c.count()).toBe(1);
  });
});
