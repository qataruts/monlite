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
