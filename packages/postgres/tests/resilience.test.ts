// Resilience / concurrency / soak harness for the Postgres engine, run against the REAL
// `monlite/postgres` Docker image (not a dev container). Proves behavior under contention,
// a mid-flight connection drop, and sustained load — the things unit tests don't exercise.
//
//   docker run -d --name monlite-pg-harden -e POSTGRES_PASSWORD=monlite -e POSTGRES_DB=monlite \
//     -p 5544:5432 monlite/postgres:16
//   MONLITE_PG_HARDEN=1 pnpm --filter @monlite/postgres vitest run tests/resilience.test.ts
//
// Gated behind MONLITE_PG_HARDEN so it doesn't run in the normal suite (it's slower + mutating).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "../src/index";
import pg from "pg";

const URL =
  process.env.MONLITE_PG_HARDEN_URL ||
  "postgres://postgres:monlite@127.0.0.1:5544/monlite";

let available = false;
if (process.env.MONLITE_PG_HARDEN) {
  try {
    const d = postgres(URL);
    await d.query("SELECT 1");
    await d.close();
    available = true;
  } catch {
    available = false;
  }
}

const waitFor = async (
  pred: () => boolean | Promise<boolean>,
  ms = 8000,
) => {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

(available ? describe : describe.skip)(
  "Postgres engine — resilience harness (monlite/postgres image)",
  () => {
    let db: any;
    let admin: pg.Client; // a side channel to perturb the server
    beforeAll(async () => {
      db = createDb(URL, { pool: { max: 12 } });
      for (const t of ["_kv", "_jobs", "race", "kill", "soak"])
        await db.asyncDriver.exec(`DROP TABLE IF EXISTS ${t} CASCADE`);
      admin = new pg.Client({ connectionString: URL });
      await admin.connect();
    });
    afterAll(async () => {
      if (admin) await admin.end().catch(() => {});
      if (db) await db.$disconnect();
    });

    it("kv.incr: 100 concurrent increments on one key lose nothing", async () => {
      const { pgKv } = await import("@monlite/kv");
      const cache = pgKv(db, { namespace: "race" });
      await Promise.all(Array.from({ length: 100 }, () => cache.incr("counter")));
      expect(await cache.get<number>("counter")).toBe(100);
    });

    it("kv.setNX: exactly one of 50 racers wins the lock", async () => {
      const { pgKv } = await import("@monlite/kv");
      const cache = pgKv(db, { namespace: "race" });
      const wins = await Promise.all(
        Array.from({ length: 50 }, (_, i) => cache.setNX("lock", i)),
      );
      expect(wins.filter(Boolean).length).toBe(1);
    });

    it("findOneAndUpdate CAS: exactly one of 40 workers claims the job", async () => {
      const c = db.collection("race");
      await c.create({ data: { _id: "job", status: "pending" } });
      const claims = await Promise.all(
        Array.from({ length: 40 }, () =>
          c.findOneAndUpdate({
            where: { _id: "job", status: "pending" },
            data: { $set: { status: "active" } },
            returnDocument: "after",
          }),
        ),
      );
      expect(claims.filter((x: any) => x != null).length).toBe(1);
    });

    it("queue: 8 workers process 200 jobs exactly once each (SKIP LOCKED under load)", async () => {
      const { createPgQueue } = await import("@monlite/queue");
      const q = createPgQueue(db);
      const seen = new Map<number, number>();
      const handler = async (job: any) =>
        void seen.set(job.payload.n, (seen.get(job.payload.n) ?? 0) + 1);
      const workers = Array.from({ length: 8 }, () =>
        q.process("soak", handler, { concurrency: 4 }),
      );
      for (let n = 0; n < 200; n++) await q.add("soak", { n });
      await waitFor(() => seen.size === 200, 20_000);
      expect([...seen.values()].every((c) => c === 1)).toBe(true);
      await Promise.all(workers.map((w) => w.stop()));
    });

    it("watch() recovers after the server drops every connection", async () => {
      await db.asyncDriver.exec(`DROP TABLE IF EXISTS kill CASCADE`);
      const w = db.collection("kill");
      const seen: string[] = [];
      const handle = w.watch({}, (e: any) => {
        for (const d of e.added ?? []) seen.push(d._id);
      });
      await waitFor(() => seen.length >= 0 && handle.results !== undefined); // init settled
      await new Promise((r) => setTimeout(r, 150));

      // baseline: a write is delivered
      await w.create({ data: { _id: "before" } });
      await waitFor(() => seen.includes("before"));

      // perturb: terminate ALL monlite-db backends (the pool clients + the LISTEN conn),
      // exactly what a Postgres restart / network reset does to in-flight connections.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = 'monlite' AND pid <> pg_backend_pid()`,
      );

      // after the driver reconnects (LISTEN re-established, pool re-checks-out), a fresh
      // write must be delivered again — proving the watcher self-heals. The pred is
      // genuinely awaited: it re-attempts the (fixed-id) write each poll until one both
      // lands AND is delivered to the now-recovered watcher.
      await new Promise((r) => setTimeout(r, 1500)); // > the 1s reconnect backoff
      await waitFor(async () => {
        await w.create({ data: { _id: "recovered" } }).catch(() => {}); // 1st lands, retries conflict (ok)
        return seen.includes("recovered");
      }, 15_000);
      expect(seen).toContain("recovered");

      handle.stop();
    });

    it("multi-process cold start: 6 independent engines race the operational DDL", async () => {
      const { createPgQueue } = await import("@monlite/queue");
      const { pgKv } = await import("@monlite/kv");
      for (const t of ["_jobs", "_kv", "_monlite_kv_pubsub", "_monlite_kv_zset", "x2"])
        await db.asyncDriver.exec(`DROP TABLE IF EXISTS ${t} CASCADE`);
      // 6 separate engines (separate pools = separate sessions, like 6 processes booting
      // at once) all first-create _jobs / _kv / x2 — exercising the cross-session catalog
      // race that CREATE … IF NOT EXISTS can lose.
      const dbs = Array.from({ length: 6 }, () => createDb(URL));
      try {
        await Promise.all(
          dbs.map(async (d: any) => {
            await createPgQueue(d).add("q", { a: 1 });
            await pgKv(d, { namespace: "x" }).set("k", 1);
            await d.collection("x2").create({ data: { v: 1 } });
          }),
        );
        expect(await db.collection("x2").count()).toBe(6); // all succeeded, no race crash
      } finally {
        await Promise.all(dbs.map((d: any) => d.$disconnect()));
      }
    });

    it("soak: 3000 mixed operations stay correct and stable", async () => {
      const c = db.collection("soak");
      const N = 3000;
      let writes = 0;
      await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          if (i % 3 === 0) {
            await c.create({ data: { _id: String(i), v: i } });
            writes++;
          } else if (i % 3 === 1) {
            await c.findMany({ where: { v: { gte: 0 } }, take: 5 });
          } else {
            await c.count({ where: { v: { lt: i } } });
          }
        }),
      );
      expect(await c.count()).toBe(writes);
    });
  },
);
