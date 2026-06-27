import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite } from "../src/index";

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("large dataset", () => {
  it("handles 20k documents: bulk insert, count, indexed query, integrity", async () => {
    const db = openDb();
    dbs.push(db);
    const c = db.collection("events", {
      schema: { kind: { type: "TEXT", index: true }, n: "INTEGER" },
    });

    const N = 20_000;
    const data = Array.from({ length: N }, (_, i) => ({
      kind: i % 5 === 0 ? "special" : "normal",
      n: i,
    }));
    await c.createMany({ data });

    expect(await c.count()).toBe(N);
    expect(await c.count({ where: { kind: "special" } })).toBe(N / 5);

    // indexed + filtered query returns exactly the expected rows
    const some = await c.findMany({
      where: { kind: "special", n: { lt: 100 } },
    });
    expect(some.length).toBe(20); // i ∈ {0,5,…,95}

    // the database is still consistent after a large write
    expect(db.checkIntegrity()).toBe(true);
    expect(db.stats().sizeBytes).toBeGreaterThan(0);
  }, 30_000);
});
