import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Monlite } from "../src/index";
import { openDb } from "./helper";

let db: Monlite;
beforeEach(async () => {
  db = openDb();
  await db.collection("users").createMany({
    data: [
      { name: "Ali", age: 28, role: "admin", active: true },
      { name: "Sara", age: 24, role: "editor", active: true },
      { name: "Omar", age: 32, role: "admin", active: true },
      { name: "Lina", age: 20, role: "editor", active: false },
    ],
  });
});
afterEach(async () => {
  await db.$disconnect();
});

describe("aggregate", () => {
  it("computes count/sum/avg/min/max", async () => {
    const res = await db.collection("users").aggregate({
      where: { active: true },
      _count: true,
      _sum: { age: true },
      _avg: { age: true },
      _min: { age: true },
      _max: { age: true },
    });
    expect(res._count).toBe(3);
    expect(res._sum).toEqual({ age: 84 });
    expect(res._avg!.age).toBeCloseTo(28);
    expect(res._min).toEqual({ age: 24 });
    expect(res._max).toEqual({ age: 32 });
  });

  it("only returns requested accumulators", async () => {
    const res = await db.collection("users").aggregate({ _count: true });
    expect(res).toEqual({ _count: 4 });
  });
});

describe("groupBy", () => {
  it("groups with accumulators and ordering", async () => {
    const res = await db.collection("users").groupBy({
      by: ["role"],
      _count: true,
      _sum: { age: true },
      _avg: { age: true },
      orderBy: { _count: "desc" },
    });

    // Both roles have 2 members; order is deterministic by count then engine order.
    const byRole = Object.fromEntries(res.map((r) => [r.role, r]));
    expect(byRole.admin._count).toBe(2);
    expect(byRole.admin._sum.age).toBe(60);
    expect(byRole.editor._count).toBe(2);
    expect(byRole.editor._sum.age).toBe(44);
  });

  it("supports where + take", async () => {
    const res = await db.collection("users").groupBy({
      by: ["role"],
      where: { active: true },
      _count: true,
      orderBy: { role: "asc" },
      take: 1,
    });
    expect(res).toHaveLength(1);
    expect(res[0].role).toBe("admin");
    expect(res[0]._count).toBe(2);
  });
});

describe("groupBy having-filters", () => {
  it("filters groups by an aggregate (_sum)", async () => {
    // admin sum(age)=60, editor sum(age)=44
    const res = await db.collection("users").groupBy({
      by: ["role"],
      _sum: { age: true },
      having: { _sum: { age: { gt: 50 } } },
    });
    expect(res.map((r) => r.role)).toEqual(["admin"]);
    expect(res[0]._sum.age).toBe(60);
  });

  it("filters by _count", async () => {
    expect(
      await db.collection("users").groupBy({
        by: ["role"],
        _count: true,
        having: { _count: { gte: 2 } },
      }),
    ).toHaveLength(2);

    expect(
      await db.collection("users").groupBy({
        by: ["role"],
        _count: true,
        having: { _count: { gt: 2 } },
      }),
    ).toHaveLength(0);
  });

  it("combines where, having and orderBy", async () => {
    const res = await db.collection("users").groupBy({
      by: ["role"],
      where: { age: { gte: 21 } }, // drops Lina(20) -> editor sum=24, admin sum=60
      _sum: { age: true },
      having: { _sum: { age: { lt: 50 } } },
      orderBy: { role: "asc" },
    });
    expect(res.map((r) => r.role)).toEqual(["editor"]);
    expect(res[0]._sum.age).toBe(24);
  });
});

describe("groupBy orderBy by accumulator (Prisma-style)", () => {
  it("orders groups by _sum / _avg, and keeps _count + by-field ordering", async () => {
    const o = db.collection("orders2");
    await o.createMany({
      data: [
        { c: "c1", total: 100 },
        { c: "c1", total: 50 },
        { c: "c2", total: 300 },
        { c: "c3", total: 30 },
      ],
    });
    const bySum = await o.groupBy({
      by: ["c"],
      _sum: { total: true },
      orderBy: { _sum: { total: "desc" } },
    });
    expect(bySum.map((r: any) => r.c)).toEqual(["c2", "c1", "c3"]); // 300, 150, 30
    const byAvg = await o.groupBy({
      by: ["c"],
      _avg: { total: true },
      orderBy: { _avg: { total: "asc" } },
    });
    expect(byAvg[0].c).toBe("c3"); // avg 30 lowest
    const byCount = await o.groupBy({
      by: ["c"],
      _count: true,
      orderBy: { _count: "desc" },
    });
    expect(byCount[0].c).toBe("c1"); // 2 rows
    const byField = await o.groupBy({
      by: ["c"],
      _sum: { total: true },
      orderBy: { c: "asc" },
    });
    expect(byField.map((r: any) => r.c)).toEqual(["c1", "c2", "c3"]);
  });
});
