import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite, type MonliteOptions } from "../src/index";

const envDriver = process.env.MONLITE_DRIVER as
  | MonliteOptions["driver"]
  | undefined;
const dir = mkdtempSync(join(tmpdir(), "monlite-mig-"));
let counter = 0;
const newFile = () => join(dir, `m${counter++}.db`);

const dbs: Monlite[] = [];
function open(file: string): Monlite {
  const db = createDb(file, envDriver ? { driver: envDriver } : {});
  dbs.push(db);
  return db;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Collection.$migrate", () => {
  it("renames, drops, and changes a column's type while preserving data", async () => {
    const file = newFile();
    const a = open(file);
    const old = a.collection("users", {
      schema: { fullname: "TEXT", age: "TEXT", legacy: "TEXT" },
    });
    await old.create({
      data: {
        _id: "u1",
        fullname: "Ali",
        age: "30",
        legacy: "x",
        extra: "kept",
      },
    });
    await a.$disconnect();
    dbs.length = 0;

    // App v2: new schema (fullname→name, age now INTEGER, legacy gone).
    const b = open(file);
    const users = b.collection("users", {
      schema: { name: "TEXT", age: "INTEGER" },
    });
    await users.$migrate({ rename: { fullname: "name" }, drop: ["legacy"] });

    const doc = await users.findById("u1");
    expect(doc).toMatchObject({
      _id: "u1",
      name: "Ali",
      age: 30,
      extra: "kept",
    });
    expect(doc && "fullname" in doc).toBe(false);
    expect(doc && "legacy" in doc).toBe(false);

    const cols = (await b.$schema("users")).map((c) => c.name);
    expect(cols).toContain("name");
    expect(cols).not.toContain("fullname");
    expect(cols).not.toContain("legacy");
  });

  it("refuses an unacknowledged column drop", async () => {
    const file = newFile();
    const a = open(file);
    await a
      .collection("t", { schema: { keep: "TEXT", remove: "TEXT" } })
      .create({
        data: { keep: "a", remove: "b" },
      });
    await a.$disconnect();
    dbs.length = 0;

    const b = open(file);
    const t = b.collection("t", { schema: { keep: "TEXT" } });
    await expect(t.$migrate()).rejects.toThrow(/isn't in the schema/);
  });

  it("validates rename source and target", async () => {
    const db = open(newFile());
    const c = db.collection("c", { schema: { name: "TEXT" } });
    await c.create({ data: { name: "x" } });
    await expect(c.$migrate({ rename: { nope: "name" } })).rejects.toThrow(
      /no such column/,
    );
    await expect(c.$migrate({ rename: { name: "ghost" } })).rejects.toThrow(
      /not in the schema/,
    );
  });

  it("preserves unique constraints and indexes across a rebuild", async () => {
    const db = open(newFile());
    const items = db.collection("items", {
      schema: {
        sku: { type: "TEXT", unique: true },
        qty: { type: "INTEGER", index: true },
      },
    });
    await items.create({ data: { _id: "i1", sku: "A1", qty: 5, note: "hi" } });

    await items.$migrate(); // no schema change — exercises the rebuild engine

    expect(await items.findById("i1")).toMatchObject({
      sku: "A1",
      qty: 5,
      note: "hi",
    });
    // unique still enforced
    await expect(
      items.create({ data: { sku: "A1", qty: 9 } }),
    ).rejects.toThrow();
    // declared index recreated
    const indexes = (
      db.driver
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_items_qty");
  });

  it("is only available on structured collections", async () => {
    const db = open(newFile());
    await expect(db.collection("docs").$migrate()).rejects.toThrow(
      /structured/,
    );
  });
});
