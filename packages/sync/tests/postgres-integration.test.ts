import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createDb, type Monlite } from "@monlite/core";
import { sync, PostgresAdapter, type SyncEngine } from "../src/index";

/**
 * Live integration tests against a real PostgreSQL.
 * Run with: PG_URL="postgres://postgres:postgres@localhost:5433/postgres" pnpm test
 * Skipped automatically when PG_URL is unset.
 */
const PG_URL = process.env.PG_URL;
const run = PG_URL ? describe : describe.skip;

let pool: any;
let counter = 0;
const schemas: string[] = [];
const locals: Monlite[] = [];
const engines: SyncEngine[] = [];

function local(nodeId: string): Monlite {
  const d = createDb(":memory:", { sync: true, nodeId });
  locals.push(d);
  return d;
}
async function freshSchema(): Promise<string> {
  const s = `mon_it_${counter++}`;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  schemas.push(s);
  return s;
}
function adapter(schema: string) {
  return new PostgresAdapter({ pool, schema });
}

beforeAll(async () => {
  if (!PG_URL) return;
  const { Pool } = (await import("pg")) as any;
  pool = new Pool({ connectionString: PG_URL });
});
afterAll(async () => {
  if (pool) await pool.end();
});
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of locals.splice(0)) await d.$disconnect();
  for (const s of schemas.splice(0)) {
    await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
});

run("PostgresAdapter — live PostgreSQL", () => {
  it("pushes documents as JSONB with version + soft-delete metadata", async () => {
    const schema = await freshSchema();
    const a = local("A");
    const e = sync(a, {
      adapter: adapter(schema),
      collections: ["users"],
      mode: "push",
    });
    engines.push(e);

    await a
      .collection("users")
      .create({ data: { _id: "u1", name: "Ali", age: 28 } });
    await e.start();

    const { rows } = await pool.query(
      `SELECT _id, doc, _monlite_v, _monlite_deleted FROM "${schema}"."users"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe("u1");
    expect(rows[0].doc).toMatchObject({ name: "Ali", age: 28 });
    expect(rows[0]._monlite_deleted).toBe(false);
    expect(typeof rows[0]._monlite_v).toBe("string");
  });

  it("round-trips create, update, and delete between two monlite dbs", async () => {
    const schema = await freshSchema();
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter(schema),
      collections: ["todos"],
      mode: "two-way",
    });
    const eb = sync(b, {
      adapter: adapter(schema),
      collections: ["todos"],
      mode: "two-way",
    });
    engines.push(ea, eb);

    await a
      .collection("todos")
      .create({ data: { _id: "t1", text: "buy milk", done: false } });
    await ea.sync(); // push to Postgres
    await eb.sync(); // pull into B
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
    const schema = await freshSchema();
    const a = local("A");
    const b = local("B");
    const ea = sync(a, {
      adapter: adapter(schema),
      collections: ["c"],
      mode: "push",
    });
    const eb = sync(b, {
      adapter: adapter(schema),
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
    expect(stats.pulled).toBe(1); // only the new row, not x1
    expect((await b.collection("c").findById("x2"))?.n).toBe(2);
  });
});
