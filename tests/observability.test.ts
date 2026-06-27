import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite, MonliteOptions } from "../src/index";

const dbs: Monlite[] = [];
function open(opts: MonliteOptions = {}): Monlite {
  const d = openDb(opts);
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("observability", () => {
  it("db.stats() reports size and object counts", async () => {
    const db = open();
    await db
      .collection("users", {
        schema: { age: { type: "INTEGER", index: true } },
      })
      .createMany({ data: [{ age: 1 }, { age: 2 }] });
    await db.collection("notes").create({ data: { t: "x" } });

    const s = db.stats();
    expect(s.collections).toBe(2);
    expect(s.indexes).toBeGreaterThan(0); // the age index
    expect(s.sizeBytes).toBeGreaterThan(0);
    expect(s.pageSize * s.pageCount).toBe(s.sizeBytes);
  });

  it("onQuery fires for each statement with timing", async () => {
    const events: Array<{ sql: string; durationMs: number }> = [];
    const db = open({ onQuery: (e) => events.push(e) });

    await db.collection("x").create({ data: { a: 1 } });
    await db.collection("x").findMany({ where: { a: 1 } });

    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (e) =>
          typeof e.sql === "string" &&
          typeof e.durationMs === "number" &&
          e.durationMs >= 0,
      ),
    ).toBe(true);
    // wire a slow-query log by filtering durationMs; here just confirm SELECTs are seen
    expect(events.some((e) => e.sql.includes("SELECT"))).toBe(true);
  });
});
