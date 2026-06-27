import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createDb, type Monlite } from "@monlite/core";
import { sync, MySqlAdapter, type SyncEngine } from "../src/index";

/**
 * Live integration tests against a real MySQL (or MariaDB).
 * Run with: MYSQL_URL="mysql://root@localhost:3307/monlite" pnpm test
 * Skipped automatically when MYSQL_URL is unset.
 */
const MYSQL_URL = process.env.MYSQL_URL;
const run = MYSQL_URL ? describe : describe.skip;

let pool: any;
const locals: Monlite[] = [];
const engines: SyncEngine[] = [];

function local(nodeId: string): Monlite {
  const d = createDb(":memory:", { sync: true, nodeId });
  locals.push(d);
  return d;
}
// Unique table names per test keep cases isolated in the shared database.
function adapter(tag: string) {
  return new MySqlAdapter({ pool, collectionMap: (n) => `${tag}_${n}` });
}

beforeAll(async () => {
  if (!MYSQL_URL) return;
  const mysql = (await import("mysql2/promise")) as any;
  pool = await mysql.createPool(MYSQL_URL);
});
afterAll(async () => {
  if (pool) await pool.end();
});
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of locals.splice(0)) await d.$disconnect();
  if (pool) {
    const [tables] = await pool.query(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`,
    );
    for (const row of tables as any[]) {
      await pool.query(`DROP TABLE IF EXISTS \`${row.t ?? row.TABLE_NAME}\``);
    }
  }
});

run("MySqlAdapter — live MySQL", () => {
  it("pushes documents as JSON with version + soft-delete metadata", async () => {
    const a = local("A");
    const e = sync(a, {
      adapter: adapter("t0"),
      collections: ["users"],
      mode: "push",
    });
    engines.push(e);

    await a
      .collection("users")
      .create({ data: { _id: "u1", name: "Ali", age: 28 } });
    await e.start();

    const [rows] = await pool.query(
      `SELECT _id, doc, _monlite_v, _monlite_deleted FROM \`t0_users\``,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe("u1");
    const doc =
      typeof rows[0].doc === "string" ? JSON.parse(rows[0].doc) : rows[0].doc;
    expect(doc).toMatchObject({ name: "Ali", age: 28 });
    expect(rows[0]._monlite_deleted).toBe(0);
  });

  it("round-trips create, update, and delete between two monlite dbs", async () => {
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter("t1"),
      collections: ["todos"],
      mode: "two-way",
    });
    const eb = sync(b, {
      adapter: adapter("t1"),
      collections: ["todos"],
      mode: "two-way",
    });
    engines.push(ea, eb);

    await a
      .collection("todos")
      .create({ data: { _id: "t1", text: "buy milk", done: false } });
    await ea.sync();
    await eb.sync();
    expect((await b.collection("todos").findById("t1"))?.text).toBe("buy milk");

    await b
      .collection("todos")
      .update({ where: { _id: "t1" }, data: { done: true } });
    await eb.sync();
    await ea.sync();
    expect((await a.collection("todos").findById("t1"))?.done).toBe(true);

    await a.collection("todos").delete({ where: { _id: "t1" } });
    await ea.sync();
    await eb.sync();
    expect(await b.collection("todos").findById("t1")).toBeNull();
  });

  it("pulls only changes after the cursor (incremental)", async () => {
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter("t2"),
      collections: ["c"],
      mode: "push",
    });
    const eb = sync(b, {
      adapter: adapter("t2"),
      collections: ["c"],
      mode: "pull",
    });
    engines.push(ea, eb);

    await a.collection("c").create({ data: { _id: "x1", n: 1 } });
    await ea.sync();
    await eb.sync();
    expect((await b.collection("c").findById("x1"))?.n).toBe(1);

    await a.collection("c").create({ data: { _id: "x2", n: 2 } });
    await ea.sync();
    const stats = await eb.sync();
    expect(stats.pulled).toBe(1);
    expect((await b.collection("c").findById("x2"))?.n).toBe(2);
  });
});
