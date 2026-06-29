import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type LiveEvent, type Monlite } from "../src/index";
import { openDb } from "./helper";

const tick = () => new Promise((r) => setTimeout(r, 0));

let db: Monlite;
let tmp: string;
beforeEach(() => {
  db = openDb();
  tmp = mkdtempSync(join(tmpdir(), "monlite-"));
});
afterEach(async () => {
  await db.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe("reactivity: collection.watch (row-level)", () => {
  it("fires init, then only on relevant changes", async () => {
    const users = db.collection("users");
    await users.create({ data: { _id: "a", name: "Ali", role: "admin" } });

    const events: LiveEvent[] = [];
    const handle = users.watch({ where: { role: "admin" } }, (e) =>
      events.push(e),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("init");
    expect(handle.results.map((d) => d._id)).toEqual(["a"]);

    // Relevant: a new admin → "add"
    await users.create({ data: { _id: "b", name: "Omar", role: "admin" } });
    await tick();
    expect(events).toHaveLength(2);
    expect(events[1].added.map((d) => d._id)).toEqual(["b"]);

    // Irrelevant: a non-admin → NO event (row-level matching)
    await users.create({ data: { _id: "c", name: "Sara", role: "editor" } });
    await tick();
    expect(events).toHaveLength(2);

    // Relevant: an admin leaves the set → "removed"
    await users.update({ where: { _id: "a" }, data: { role: "editor" } });
    await tick();
    expect(events).toHaveLength(3);
    expect(events[2].removed.map((d) => d._id)).toEqual(["a"]);

    // Relevant: delete an admin
    await users.delete({ where: { _id: "b" } });
    await tick();
    expect(events).toHaveLength(4);
    expect(events[3].removed.map((d) => d._id)).toEqual(["b"]);
    expect(handle.results).toHaveLength(0);

    // After stop: no more events
    handle.stop();
    await users.create({ data: { role: "admin" } });
    await tick();
    expect(events).toHaveLength(4);
  });

  it("reports changed documents", async () => {
    const c = db.collection("c");
    const d = await c.create({ data: { active: true, n: 1 } });
    const events: LiveEvent[] = [];
    c.watch({ where: { active: true } }, (e) => events.push(e));

    await c.update({ where: { _id: d._id }, data: { n: 2 } });
    await tick();
    expect(events).toHaveLength(2);
    expect(events[1].changed.map((x) => x._id)).toEqual([d._id]);
    expect(events[1].results[0].n).toBe(2);
  });

  it("a throwing watch callback does not break sibling watchers (swarm-found)", async () => {
    const c = db.collection("c");
    const errs: unknown[] = [];
    const spy = console.error;
    console.error = (...a: unknown[]) => errs.push(a);
    let bFired = 0;
    try {
      c.watch({}, (e) => {
        if (e.type === "change") throw new Error("boom in A");
      });
      c.watch({}, () => {
        bFired++;
      });
      await c.create({ data: { _id: "1", n: 1 } });
      await tick();
      const afterFirst = bFired;
      await c.create({ data: { _id: "2", n: 2 } });
      await tick();
      expect(bFired).toBeGreaterThan(afterFirst); // sibling kept firing
      expect((await c.findById("2"))!.n).toBe(2); // db still writable
      expect(errs.length).toBeGreaterThan(0); // error surfaced, not swallowed
    } finally {
      console.error = spy;
    }
  });
});

describe("$collections excludes plugin/internal tables (swarm-found)", () => {
  it("returns only real collections (tables with an _id column)", async () => {
    await db.collection("posts").create({ data: { _id: "a", title: "x" } });
    await db.collection("users").create({ data: { _id: "u", name: "y" } });
    // Simulate a plugin's auxiliary table (no _id column) — e.g. queue _jobs / fts shadow.
    db.sqlite.exec(`CREATE TABLE "posts_aux" (doc_id TEXT, blob TEXT)`);
    db.sqlite.exec(`CREATE TABLE "_jobs" (id INTEGER, queue TEXT)`);
    expect(await db.$collections()).toEqual(["posts", "users"]);
  });
});

describe("explain()", () => {
  it("reports index usage", async () => {
    const orders = db.collection("orders", {
      schema: { status: { type: "TEXT", index: true } },
    });
    await orders.create({ data: { status: "paid" } });

    const indexed = await orders.explain({ where: { status: "paid" } });
    expect(indexed.usesIndex).toBe(true);

    const scan = await orders.explain({});
    expect(scan.usesIndex).toBe(false);
    expect(scan.plan.length).toBeGreaterThan(0);
  });
});

describe("backup()", () => {
  it("writes a consistent snapshot that reopens with the data", async () => {
    await db.collection("users").createMany({
      data: [{ name: "A" }, { name: "B" }],
    });
    const dest = join(tmp, "snapshot.db");
    await db.backup(dest);

    const restored = createDb(dest);
    expect(await restored.collection("users").count()).toBe(2);
    await restored.$disconnect();
  });
});

describe("auto-additive migration", () => {
  it("adds new declared columns to an existing structured table", async () => {
    const file = join(tmp, "mig.db");

    const a = createDb(file);
    await a
      .collection("orders", { schema: { amount: "REAL" } })
      .create({ data: { amount: 10 } });
    await a.$disconnect();

    // Reopen with an extra declared column → auto ALTER ADD COLUMN.
    const b = createDb(file);
    const orders = b.collection("orders", {
      schema: { amount: "REAL", status: { type: "TEXT", default: "new" } },
    });
    const cols = (await b.$schema("orders")).map((c) => c.name);
    expect(cols).toContain("status");

    // Existing row got the default; new writes use the native column.
    const existing = await orders.findFirst({});
    expect(existing!.status).toBe("new");
    await orders.create({ data: { amount: 20, status: "paid" } });
    expect(await orders.count({ where: { status: "paid" } })).toBe(1);
    await b.$disconnect();
  });
});
