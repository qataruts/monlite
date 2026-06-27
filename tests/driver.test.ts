import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "../src/index";

const [maj, min] = process.versions.node.split(".").map(Number);
const HAS_NODE_SQLITE = maj! > 22 || (maj === 22 && min! >= 5);

let db: Monlite;
afterEach(async () => {
  await db?.$disconnect();
});

describe("drivers", () => {
  it("better-sqlite3 backend works", async () => {
    db = createDb(":memory:", { driver: "better-sqlite3" });
    expect(db.driverName).toBe("better-sqlite3");
    const c = db.collection("t");
    await c.createMany({ data: [{ n: 1 }, { n: 2 }] });
    expect(await c.count({ where: { n: { gte: 2 } } })).toBe(1);
  });

  it.skipIf(!HAS_NODE_SQLITE)(
    "node:sqlite backend works (Node >= 22.5)",
    async () => {
      db = createDb(":memory:", { driver: "node:sqlite" });
      expect(db.driverName).toBe("node:sqlite");
      const c = db.collection("t");
      // exercises nested SAVEPOINT transactions (createMany) + json queries
      await c.createMany({ data: [{ n: 1 }, { n: 2 }, { n: 3 }] });
      const g = await c.groupBy({
        by: ["n"],
        _count: true,
        orderBy: { n: "asc" },
      });
      expect(g.map((r) => r.n)).toEqual([1, 2, 3]);

      // transaction rollback on the manual BEGIN/COMMIT path
      await expect(
        db.$transaction(() => {
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await c.count()).toBe(3);
    },
  );

  it.skipIf(!HAS_NODE_SQLITE)(
    "both backends produce identical results",
    async () => {
      const a = createDb(":memory:", { driver: "better-sqlite3" });
      const b = createDb(":memory:", { driver: "node:sqlite" });
      const seed = [
        { name: "Ali", age: 28, tags: ["x"] },
        { name: "Sara", age: 24, tags: ["y", "z"] },
        { name: "Omar", age: 31, tags: ["x", "z"] },
      ];
      for (const d of [a, b])
        await d.collection("u").createMany({ data: seed });

      const query = {
        where: { age: { gte: 25 }, tags: { contains: "x" } },
        orderBy: { age: "desc" as const },
      };
      const ra = (await a.collection("u").findMany(query)).map((x) => x.name);
      const rb = (await b.collection("u").findMany(query)).map((x) => x.name);

      expect(ra).toEqual(["Omar", "Ali"]);
      expect(rb).toEqual(ra);

      await a.$disconnect();
      await b.$disconnect();
    },
  );
});
