import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MonliteError,
  MonliteQueryError,
  MonliteUniqueConstraintError,
  type Monlite,
} from "../src/index";
import { openDb } from "./helper";

let db: Monlite;
beforeEach(() => {
  db = openDb();
});
afterEach(async () => {
  await db.$disconnect();
});

describe("security: SQL injection", () => {
  it("a malicious groupBy field name cannot break out of SQL", async () => {
    const c = db.collection("u");
    await c.createMany({ data: [{ x: 1 }, { x: 2 }] });
    // Pre-fix this alias-injected a sub-select; now it's a harmless JSON path.
    const evil = 'x" AS y, (SELECT 1) AS z --';
    // Generated aliases + path escaping mean this can't inject; SQLite safely
    // rejects the malformed path as a normalized MonliteError (no breakout).
    await expect(c.groupBy({ by: [evil], _count: true })).rejects.toBeInstanceOf(
      MonliteError,
    );
    // A normal groupBy still works (alias fix didn't break the happy path).
    const ok = await c.groupBy({ by: ["x"], _count: true, orderBy: { x: "asc" } });
    expect(ok.map((r) => r.x)).toEqual([1, 2]);
  });
});

describe("security: prototype pollution", () => {
  it("rejects __proto__ in update paths and does not pollute", async () => {
    const c = db.collection("u");
    const d = await c.create({ data: { n: 1 } });
    await expect(
      c.update({
        where: { _id: d._id },
        data: { $set: { "__proto__.polluted": "yes" } },
      }),
    ).rejects.toBeInstanceOf(MonliteQueryError);
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("typed errors", () => {
  it("maps a primary-key collision to MonliteUniqueConstraintError", async () => {
    const c = db.collection("u");
    await c.create({ data: { _id: "dup", n: 1 } });
    await expect(
      c.create({ data: { _id: "dup", n: 2 } }),
    ).rejects.toBeInstanceOf(MonliteUniqueConstraintError);
  });

  it("maps a UNIQUE column violation in a structured collection", async () => {
    const c = db.collection("acc", {
      schema: { email: { type: "TEXT", unique: true } },
    });
    await c.create({ data: { email: "a@x.com" } });
    await expect(
      c.create({ data: { email: "a@x.com" } }),
    ).rejects.toBeInstanceOf(MonliteUniqueConstraintError);
  });
});

describe("update integrity", () => {
  it("$inc rejects a non-finite operand instead of nulling the field", async () => {
    const c = db.collection("u");
    const d = await c.create({ data: { n: 5 } });
    await expect(
      c.update({ where: { _id: d._id }, data: { $inc: { n: "x" as any } } }),
    ).rejects.toBeInstanceOf(MonliteQueryError);
    expect((await c.findById(d._id))!.n).toBe(5);
  });
});

describe("structured integrity", () => {
  it("rejects an object/array in a non-JSON column", async () => {
    const c = db.collection("s", { schema: { name: "TEXT" } });
    await expect(
      c.create({ data: { name: { nested: 1 } } }),
    ).rejects.toBeInstanceOf(MonliteQueryError);
  });

  it("round-trips an explicit null in a native column", async () => {
    const c = db.collection("s2", { schema: { age: "INTEGER" } });
    const d = await c.create({ data: { age: null } });
    expect((await c.findById(d._id))!.age).toBeNull();
  });

  it("throws on conflicting schema re-declaration", () => {
    db.collection("s3", { schema: { a: "TEXT" } });
    expect(() => db.collection("s3", { schema: { b: "INTEGER" } })).toThrow();
  });
});

describe("new query methods", () => {
  beforeEach(async () => {
    await db.collection("u").create({ data: { _id: "k", n: 1 } });
  });

  it("findUnique", async () => {
    expect(await db.collection("u").findUnique({ where: { _id: "k" } })).toMatchObject({ n: 1 });
  });
  it("exists", async () => {
    expect(await db.collection("u").exists({ n: 1 })).toBe(true);
    expect(await db.collection("u").exists({ n: 999 })).toBe(false);
  });
  it("findFirstOrThrow", async () => {
    await expect(
      db.collection("u").findFirstOrThrow({ where: { n: 999 } }),
    ).rejects.toThrow();
  });
});
