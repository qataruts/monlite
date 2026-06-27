import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite } from "../src/index";

const dbs: Monlite[] = [];
function db(): Monlite {
  const d = openDb();
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("Mongo-API operators", () => {
  it("$addToSet adds only new values (with $each)", async () => {
    const c = db().collection("x");
    await c.create({ data: { _id: "a", tags: ["x"] } });
    await c.update({ where: { _id: "a" }, data: { $addToSet: { tags: "x" } } }); // dup → no-op
    await c.update({ where: { _id: "a" }, data: { $addToSet: { tags: "y" } } });
    await c.update({
      where: { _id: "a" },
      data: { $addToSet: { tags: { $each: ["y", "z"] } } },
    });
    expect((await c.findById("a"))!.tags).toEqual(["x", "y", "z"]);
  });

  it("findOneAndUpdate returns the after (default) or before document", async () => {
    const c = db().collection("c");
    await c.create({ data: { _id: "1", n: 1 } });

    const after = await c.findOneAndUpdate({
      where: { _id: "1" },
      data: { $inc: { n: 1 } },
    });
    expect(after?.n).toBe(2);

    const before = await c.findOneAndUpdate({
      where: { _id: "1" },
      data: { $inc: { n: 1 } },
      returnDocument: "before",
    });
    expect(before?.n).toBe(2); // value before that update
    expect((await c.findById("1"))!.n).toBe(3);

    expect(
      await c.findOneAndUpdate({
        where: { _id: "nope" },
        data: { $set: { n: 0 } },
      }),
    ).toBeNull();
  });

  it("bulkWrite runs mixed ops in one transaction", async () => {
    const c = db().collection("b");
    await c.createMany({
      data: [
        { _id: "u1", v: 1 },
        { _id: "u2", v: 2 },
      ],
    });
    const res = await c.bulkWrite([
      { insertOne: { _id: "u3", v: 3 } },
      { updateOne: { where: { _id: "u1" }, data: { $set: { v: 10 } } } },
      { deleteOne: { where: { _id: "u2" } } },
    ]);
    expect(res).toEqual({ inserted: 1, updated: 1, deleted: 1 });
    expect(await c.count()).toBe(2); // u1, u3
    expect((await c.findById("u1"))!.v).toBe(10);
    expect(await c.findById("u2")).toBeNull();
  });

  it("bulkWrite is atomic — a failing op rolls back the whole batch", async () => {
    const c = db().collection("acct", {
      schema: { sku: { type: "TEXT", unique: true } },
    });
    await c.create({ data: { _id: "a", sku: "A" } });
    await expect(
      c.bulkWrite([
        { insertOne: { _id: "b", sku: "B" } },
        { insertOne: { _id: "c", sku: "A" } }, // duplicate → unique violation
      ]),
    ).rejects.toThrow();
    expect(await c.count()).toBe(1); // "b" rolled back along with the failing insert
  });
});
