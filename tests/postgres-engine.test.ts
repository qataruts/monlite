// Proves a REAL @monlite/core Collection method runs on a live Postgres engine —
// the whole stack: createDb engine-selection → db.asyncDriver → ensureTablePg →
// count's PG branch → the shared buildWhere(dialect:"postgres"). The inline PgDriver
// is the AsyncDriver shape the production @monlite/postgres package will provide.
// Skips cleanly without a reachable Postgres (like the Python interop tests).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../src/index";

class PgDriver {
  readonly name = "postgres";
  readonly async = true as const;
  constructor(private client: any) {}
  // The builder emits "?" placeholders; Postgres wants $1,$2,…
  private conv(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
  async exec(sql: string): Promise<void> {
    await this.client.query(this.conv(sql));
  }
  async query(sql: string, params: any[] = []) {
    const r = await this.client.query(this.conv(sql), params);
    return { rows: r.rows, changes: r.rowCount ?? 0 };
  }
  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN");
    try {
      const r = await fn();
      await this.client.query("COMMIT");
      return r;
    } catch (e) {
      await this.client.query("ROLLBACK");
      throw e;
    }
  }
  afterCommit(cb: () => void): void {
    cb();
  }
  async close(): Promise<void> {
    await this.client.end();
  }
}

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

let pgMod: any;
let available = false;
try {
  pgMod = (await import("pg")).default;
  const probe = new pgMod.Client({
    connectionString: URL,
    connectionTimeoutMillis: 1500,
  });
  await probe.connect();
  await probe.end();
  available = true;
} catch {
  available = false;
}

(available ? describe : describe.skip)(
  "@monlite/core Collection on a live Postgres engine",
  () => {
    let db: any;
    let client: any;

    beforeAll(async () => {
      client = new pgMod.Client({ connectionString: URL });
      await client.connect();
      await client.query(`DROP TABLE IF EXISTS users CASCADE`);
      await client.query(
        `CREATE TABLE "users" (_id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL)`,
      );
      for (const [_id, data] of [
        ["1", { name: "Ada", age: 30, role: "admin" }],
        ["2", { name: "Bo", age: 17, role: "user" }],
        ["3", { name: "Cy", age: 40, role: "user" }],
      ] as const) {
        await client.query(
          `INSERT INTO "users"(_id, data, created_at, updated_at) VALUES ($1, $2, 1, 1)`,
          [_id, JSON.stringify(data)],
        );
      }
      // Engine selection: a Monlite backed by the async Postgres engine.
      db = createDb(":memory:", { driver: new PgDriver(client) as any });
    });
    afterAll(async () => {
      if (db) await db.$disconnect();
    });

    it("exposes the engine as db.asyncDriver", () => {
      expect(db.asyncDriver?.name).toBe("postgres");
    });

    it("count() runs through the real Collection on Postgres", async () => {
      const users = db.collection("users");
      expect(await users.count()).toBe(3);
      expect(await users.count({ where: { role: "admin" } })).toBe(1);
      expect(await users.count({ where: { age: { gte: 18 } } })).toBe(2);
      expect(
        await users.count({ where: { OR: [{ role: "admin" }, { age: { gte: 40 } }] } }),
      ).toBe(2);
      expect(await users.count({ where: { name: { startsWith: "A" } } })).toBe(1);
    });
  },
);
