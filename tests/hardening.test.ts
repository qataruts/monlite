import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
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
    // Pre-fix this alias-injected a sub-select. Generated aliases + JSON-string
    // path escaping now make it a harmless JSON-path key: no breakout (no injected
    // y/z columns), just one group keyed by the literal (non-matching) field name.
    const evil = 'x" AS y, (SELECT 1) AS z --';
    const res = await c.groupBy({ by: [evil], _count: true });
    expect(res.length).toBe(1);
    expect(Object.keys(res[0])).not.toContain("y");
    expect(Object.keys(res[0])).not.toContain("z");
    expect((res[0] as any)._count).toBe(2);
    // A normal groupBy still works (alias fix didn't break the happy path).
    const ok = await c.groupBy({
      by: ["x"],
      _count: true,
      orderBy: { x: "asc" },
    });
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
    expect(
      await db.collection("u").findUnique({ where: { _id: "k" } }),
    ).toMatchObject({ n: 1 });
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

describe("driver parity: large integers + NUL bytes (swarm-found)", () => {
  it("rejects a number above 2^53 in an INTEGER column (silent precision loss)", async () => {
    const c = db.collection("ints", { schema: { big: "INTEGER" } });
    await expect(
      c.create({ data: { big: Number.MAX_SAFE_INTEGER + 1 } }),
    ).rejects.toBeInstanceOf(MonliteQueryError);
    // a safe integer is fine, and a BigInt is the supported way to store large ids
    await expect(
      c.create({ data: { _id: "ok", big: 42 } }),
    ).resolves.toBeTruthy();
    const d = await c.create({ data: { _id: "b", big: 9007199254740993n } });
    // reads back as a JS number on BOTH drivers (node:sqlite no longer throws)
    expect(typeof (await c.findById(d._id))!.big).toBe("number");
    // write result counts are plain numbers on BOTH drivers (not BigInt under
    // node:sqlite's readBigInts) — guards the 2.6.14→2.6.15 run() coercion.
    const res = await c.deleteMany({ where: { _id: "ok" } });
    expect(typeof res.count).toBe("number");
    expect(res.count).toBe(1);
  });

  it("rejects a NUL byte in a raw TEXT column (driver-divergent truncation)", async () => {
    const c = db.collection("texts", { schema: { note: "TEXT" } });
    await expect(
      c.create({ data: { note: "a\u0000b" } }),
    ).rejects.toBeInstanceOf(MonliteQueryError);
    // ordinary strings are unaffected
    await expect(
      c.create({ data: { note: "hello world" } }),
    ).resolves.toBeTruthy();
  });
});
