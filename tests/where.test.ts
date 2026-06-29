import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Monlite } from "../src/index";
import { openDb } from "./helper";

let db: Monlite;

beforeEach(async () => {
  db = openDb();
  await db.collection("users").createMany({
    data: [
      {
        name: "Ali",
        age: 28,
        role: "admin",
        tags: ["a", "b"],
        address: { city: "Riyadh" },
      },
      {
        name: "Sara",
        age: 24,
        role: "editor",
        tags: ["b", "c"],
        address: { city: "Jeddah" },
      },
      {
        name: "Omar",
        age: 31,
        role: "admin",
        tags: ["c"],
        address: { city: "Riyadh" },
      },
      { name: "Lina", age: 19, role: "guest", address: { city: "Mecca" } },
    ],
  });
});
afterEach(async () => {
  await db.$disconnect();
});

const names = async (where: any) =>
  (
    await db.collection("users").findMany({ where, orderBy: { name: "asc" } })
  ).map((u: any) => u.name);

describe("comparison operators", () => {
  it("equals (shorthand and explicit)", async () => {
    expect(await names({ name: "Ali" })).toEqual(["Ali"]);
    expect(await names({ name: { equals: "Ali" } })).toEqual(["Ali"]);
  });

  it("not includes missing fields", async () => {
    expect(await names({ role: { not: "admin" } })).toEqual(["Lina", "Sara"]);
  });

  it("gt / gte / lt / lte", async () => {
    expect(await names({ age: { gte: 28 } })).toEqual(["Ali", "Omar"]);
    expect(await names({ age: { lt: 24 } })).toEqual(["Lina"]);
    expect(await names({ age: { gt: 24, lte: 31 } })).toEqual(["Ali", "Omar"]);
  });

  it("in / notIn", async () => {
    expect(await names({ role: { in: ["admin", "guest"] } })).toEqual([
      "Ali",
      "Lina",
      "Omar",
    ]);
    expect(await names({ role: { notIn: ["admin"] } })).toEqual([
      "Lina",
      "Sara",
    ]);
  });
});

describe("string operators", () => {
  it("contains on a string field (substring)", async () => {
    expect(await names({ name: { contains: "li" } })).toEqual(["Ali"]);
  });
  it("startsWith / endsWith", async () => {
    expect(await names({ name: { startsWith: "S" } })).toEqual(["Sara"]);
    expect(await names({ name: { endsWith: "a" } })).toEqual(["Lina", "Sara"]);
  });
  it("mode: insensitive matches case-insensitively", async () => {
    // case-sensitive "li" misses "Lina" (capital L); insensitive catches it
    expect(await names({ name: { contains: "li" } })).toEqual(["Ali"]);
    expect(
      await names({ name: { contains: "li", mode: "insensitive" } }),
    ).toEqual(["Ali", "Lina"]);
    expect(
      await names({ name: { startsWith: "s", mode: "insensitive" } }),
    ).toEqual(["Sara"]);
  });
});

describe("array operators", () => {
  it("contains on an array field (membership)", async () => {
    expect(await names({ tags: { contains: "b" } })).toEqual(["Ali", "Sara"]);
  });
  it("has is explicit array membership", async () => {
    expect(await names({ tags: { has: "c" } })).toEqual(["Omar", "Sara"]);
  });
});

describe("existence + nested paths", () => {
  it("exists true/false", async () => {
    expect(await names({ tags: { exists: true } })).toEqual([
      "Ali",
      "Omar",
      "Sara",
    ]);
    expect(await names({ tags: { exists: false } })).toEqual(["Lina"]);
  });
  it("dot-notation nested path", async () => {
    expect(await names({ "address.city": "Riyadh" })).toEqual(["Ali", "Omar"]);
    expect(await names({ "address.city": { equals: "Jeddah" } })).toEqual([
      "Sara",
    ]);
  });
});

describe("logical operators", () => {
  it("AND", async () => {
    expect(
      await names({ AND: [{ role: "admin" }, { "address.city": "Riyadh" }] }),
    ).toEqual(["Ali", "Omar"]);
  });
  it("OR", async () => {
    expect(
      await names({ OR: [{ role: "guest" }, { age: { gte: 31 } }] }),
    ).toEqual(["Lina", "Omar"]);
  });
  it("NOT", async () => {
    expect(await names({ NOT: { role: "admin" } })).toEqual(["Lina", "Sara"]);
  });
  it("implicit AND across fields", async () => {
    expect(await names({ role: "admin", age: { gt: 30 } })).toEqual(["Omar"]);
  });
});

describe("NOT matches null/missing-field documents (regression: fuzz-found)", () => {
  it("{ NOT: {...} } is equivalent to the not operator and includes missing/null", async () => {
    const db2 = openDb();
    const c = db2.collection("nn");
    await c.createMany({
      data: [
        { _id: "has5", n: 5 },
        { _id: "missing" },
        { _id: "other", n: 3 },
        { _id: "nul", n: null },
      ],
    });
    const ids = async (w: any) =>
      (await c.findMany({ where: w })).map((d: any) => d._id).sort();
    // a missing/null `n` IS "not 5" — NOT must include them, like the not operator
    expect(await ids({ NOT: { n: 5 } })).toEqual(["missing", "nul", "other"]);
    expect(await ids({ n: { not: 5 } })).toEqual(["missing", "nul", "other"]);
    // comparison-based inner predicates too
    expect(await ids({ NOT: { n: { gt: 4 } } })).toEqual([
      "missing",
      "nul",
      "other",
    ]);
    // nested combinators
    expect(await ids({ AND: [{ NOT: { n: 5 } }, { NOT: { n: 3 } }] })).toEqual([
      "missing",
      "nul",
    ]);
    await db2.$disconnect();
  });
});
