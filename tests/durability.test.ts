import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite, type MonliteOptions } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const dir = mkdtempSync(join(tmpdir(), "monlite-dur-"));
let counter = 0;
const tmpFile = () => join(dir, `d${counter++}.db`);

const dbs: Monlite[] = [];
function open(file?: string, opts: MonliteOptions = {}): Monlite {
  const d = createDb(file ?? ":memory:", {
    ...(driver ? { driver } : {}),
    ...opts,
  });
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("durability & maintenance", () => {
  it("checkIntegrity reports a healthy database", async () => {
    const db = open();
    await db.collection("x").create({ data: { a: 1 } });
    expect(db.checkIntegrity()).toBe(true);
    expect(db.checkIntegrity(true)).toBe(true); // quick_check
  });

  it("vacuum / analyze / checkpoint run without error", async () => {
    const db = open(tmpFile()); // file → WAL active for checkpoint
    await db.collection("x").createMany({ data: [{ a: 1 }, { a: 2 }] });
    db.analyze();
    db.checkpoint("TRUNCATE");
    db.vacuum();
    expect(await db.collection("x").count()).toBe(2);
  });

  it("accepts the synchronous durability option", async () => {
    const db = open(tmpFile(), { synchronous: "FULL" });
    await db.collection("x").create({ data: { a: 1 } });
    expect(await db.collection("x").count()).toBe(1);
  });

  it("persists auto-index counters across restarts", async () => {
    const file = tmpFile();
    let db = open(file, { autoIndexAfter: 3 });
    await db.collection("users").createMany({ data: [{ age: 1 }, { age: 2 }] });
    // Two queries on `age` (below the threshold of 3) — no index yet.
    await db.collection("users").findMany({ where: { age: { gte: 1 } } });
    await db.collection("users").findMany({ where: { age: { gte: 1 } } });
    const idxName = (d: Monlite) =>
      (
        d.driver
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users' AND name LIKE 'idx_users_%'`,
          )
          .all() as Array<{ name: string }>
      ).length;
    expect(idxName(db)).toBe(0); // not yet indexed
    await db.$disconnect();
    dbs.length = 0;

    // Reopen: the count (2) was persisted, so ONE more query crosses the
    // threshold and creates the index. Without persistence it would reset to 0.
    db = open(file, { autoIndexAfter: 3 });
    await db.collection("users").findMany({ where: { age: { gte: 1 } } });
    expect(idxName(db)).toBeGreaterThan(0);
  });
});
