import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, MonliteQueryError, type Monlite } from "../src/index";

let db: Monlite;
beforeEach(() => {
  db = createDb(":memory:");
});
afterEach(async () => {
  await db.$disconnect();
});

describe("update operators", () => {
  it("$set with nested dot path", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { name: "Ali", address: { city: "Riyadh" } } });
    const u = await c.update({
      where: { _id: d._id },
      data: { $set: { "address.city": "Jeddah", verified: true } },
    });
    expect(u).toMatchObject({
      name: "Ali",
      address: { city: "Jeddah" },
      verified: true,
    });
  });

  it("$inc increments (missing field starts at 0)", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { score: 5 } });
    expect((await c.update({ where: { _id: d._id }, data: { $inc: { score: 3 } } }))!.score).toBe(8);
    expect((await c.update({ where: { _id: d._id }, data: { $inc: { fresh: 1 } } }))!.fresh).toBe(1);
  });

  it("$push appends, $each pushes many", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { tags: ["a"] } });
    let u = await c.update({ where: { _id: d._id }, data: { $push: { tags: "b" } } });
    expect(u!.tags).toEqual(["a", "b"]);
    u = await c.update({
      where: { _id: d._id },
      data: { $push: { tags: { $each: ["c", "d"] } } },
    });
    expect(u!.tags).toEqual(["a", "b", "c", "d"]);
  });

  it("$pull removes matching elements", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { tags: ["a", "b", "a", "c"] } });
    const u = await c.update({ where: { _id: d._id }, data: { $pull: { tags: "a" } } });
    expect(u!.tags).toEqual(["b", "c"]);
  });

  it("$unset removes a field", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { name: "Ali", temp: 1 } });
    const u = await c.update({ where: { _id: d._id }, data: { $unset: { temp: true } } });
    expect(u).toMatchObject({ name: "Ali" });
    expect("temp" in (u as any)).toBe(false);
  });

  it("cannot change _id via update", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { name: "Ali" } });
    const u = await c.update({ where: { _id: d._id }, data: { _id: "hacked" } as any });
    expect(u!._id).toBe(d._id);
    expect(await c.findById("hacked")).toBeNull();
  });

  it("throws when mixing operators and plain fields", async () => {
    const c = db.collection("docs");
    const d = await c.create({ data: { name: "Ali" } });
    await expect(
      c.update({ where: { _id: d._id }, data: { $set: { a: 1 }, b: 2 } as any }),
    ).rejects.toBeInstanceOf(MonliteQueryError);
  });
});
