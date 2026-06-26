import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type Monlite } from "../src/index";

let db: Monlite;
beforeEach(async () => {
  db = createDb(":memory:");
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
