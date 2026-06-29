// Proves the SHARED core where-builder — the exact same `buildWhere` that serves
// SQLite — emits correct results on a live Postgres when `dialect: "postgres"`.
// This is the payoff of B: one builder, two engines. Skips cleanly when no Postgres
// is reachable (CI without a PG service), like the Python interop tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildWhere, type WhereContext } from "../src/query/where";

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

// The builder emits "?" placeholders (SQLite style); the Postgres driver rewrites
// them to $1,$2,…. Mirror that here.
const toPg = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

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
  "buildWhere — postgres dialect, against live Postgres",
  () => {
    let client: any;

    beforeAll(async () => {
      client = new pgMod.Client({ connectionString: URL });
      await client.connect();
      await client.query(`DROP TABLE IF EXISTS docs CASCADE`);
      await client.query(
        `CREATE TABLE docs (_id text PRIMARY KEY, data jsonb NOT NULL)`,
      );
      const seed = [
        { _id: "1", name: "Ada", age: 30, role: "admin", tags: ["a", "b"], addr: { city: "Doha" }, items: [{ q: 2 }, { q: 9 }] },
        { _id: "2", name: "Bo", age: 17, role: "user", tags: ["b"], addr: { city: "Rome" } },
        { _id: "3", name: "Cy", age: 40, role: "user", tags: ["c"], email: "cy@example.com" },
      ];
      for (const { _id, ...data } of seed) {
        await client.query(`INSERT INTO docs VALUES ($1, $2)`, [_id, JSON.stringify(data)]);
      }
    });
    afterAll(async () => {
      if (client) await client.end();
    });

    // Build PG SQL via CORE's buildWhere, run it, return matching ids in order.
    const ids = async (where: any): Promise<string[]> => {
      const ctx: WhereContext = { params: [], dialect: "postgres" };
      const sql = buildWhere(where, ctx);
      const r = await client.query(
        `SELECT _id FROM docs WHERE ${toPg(sql)} ORDER BY _id`,
        ctx.params,
      );
      return r.rows.map((x: any) => x._id);
    };

    it("equals, ranges, in/notIn, not", async () => {
      expect(await ids({ name: "Ada" })).toEqual(["1"]);
      expect(await ids({ age: { gte: 18, lt: 40 } })).toEqual(["1"]);
      expect(await ids({ role: { in: ["admin", "user"] } })).toEqual(["1", "2", "3"]);
      expect(await ids({ role: { not: "user" } })).toEqual(["1"]);
      expect(await ids({ age: { notIn: [17, 40] } })).toEqual(["1"]);
    });

    it("string ops: contains/startsWith/endsWith/regex (+ insensitive)", async () => {
      expect(await ids({ name: { contains: "d" } })).toEqual(["1"]);
      expect(await ids({ name: { contains: "ada", mode: "insensitive" } })).toEqual(["1"]);
      expect(await ids({ name: { startsWith: "B" } })).toEqual(["2"]);
      expect(await ids({ email: { endsWith: ".com" } })).toEqual(["3"]);
      expect(await ids({ email: { regex: "@example\\.com$" } })).toEqual(["3"]);
    });

    it("arrays + nested: has, elemMatch, nested path", async () => {
      expect(await ids({ tags: { has: "b" } })).toEqual(["1", "2"]);
      expect(await ids({ items: { elemMatch: { q: { gte: 5 } } } })).toEqual(["1"]);
      expect(await ids({ "addr.city": "Rome" })).toEqual(["2"]);
    });

    it("boolean logic, exists, and the _id column branch", async () => {
      expect(await ids({ AND: [{ role: "user" }, { age: { gt: 18 } }] })).toEqual(["3"]);
      expect(await ids({ OR: [{ role: "admin" }, { age: { gte: 40 } }] })).toEqual(["1", "3"]);
      expect(await ids({ NOT: [{ role: "user" }] })).toEqual(["1"]);
      expect(await ids({ email: { exists: true } })).toEqual(["3"]);
      expect(await ids({ _id: "2" })).toEqual(["2"]);
      expect(await ids({ _id: { in: ["1", "3"] } })).toEqual(["1", "3"]);
      expect(await ids(undefined)).toEqual(["1", "2", "3"]); // empty where → "true"
    });
  },
);
