// @monlite/queue on the Postgres engine: PgQueue, claiming with FOR UPDATE SKIP LOCKED.
// Skips cleanly without a reachable Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "@monlite/postgres";
import { createPgQueue } from "../src/index";

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

let available = false;
try {
  const d = postgres(URL);
  await d.query("SELECT 1");
  await d.close();
  available = true;
} catch {
  available = false;
}

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};

(available ? describe : describe.skip)(
  "@monlite/queue on Postgres (SKIP LOCKED)",
  () => {
    let db: any;
    beforeAll(async () => {
      db = createDb(URL);
      await db.asyncDriver.exec(`DROP TABLE IF EXISTS _jobs CASCADE`);
    });
    afterAll(async () => {
      if (db) await db.$disconnect();
    });

    it("processes a job and emits completed", async () => {
      const q = createPgQueue(db);
      const results: any[] = [];
      q.on("completed", (job, result) => results.push({ id: job.id, result }));
      const w = q.process("email", async (job: any) => `sent:${job.payload.to}`);
      const job = await q.add("email", { to: "a@b.c" });
      expect(job.status).toBe("pending");
      await waitFor(() => results.length > 0);
      expect(results[0].result).toBe("sent:a@b.c");
      expect((await q.counts("email")).done).toBe(1);
      await w.stop();
    });

    it("retries with backoff, then dead-letters", async () => {
      const q = createPgQueue(db, { maxAttempts: 2, backoff: () => 10 });
      let attempts = 0;
      // "failed" fires on every attempt failure (retry AND dead-letter), per the contract.
      const failedAt: number[] = [];
      q.on("failed", (job) => failedAt.push(job.attempts));
      const w = q.process("flaky", async () => {
        attempts++;
        throw new Error("boom");
      });
      await q.add("flaky", {});
      await waitFor(() => failedAt.length >= 2); // retry-fail (attempt 1) + dead-letter (attempt 2)
      expect(attempts).toBe(2);
      expect(failedAt).toEqual([1, 2]);
      expect((await q.counts("flaky")).failed).toBe(1);
      await w.stop();
    });

    it("dedupes by jobId", async () => {
      const q = createPgQueue(db);
      const j1 = await q.add("dd", { x: 1 }, { jobId: "k1" });
      const j2 = await q.add("dd", { x: 2 }, { jobId: "k1" });
      expect(j2.id).toBe(j1.id); // existing pending job returned, not a duplicate
      expect((await q.counts("dd")).pending).toBe(1);
    });

    it("two concurrent workers never double-process a job (SKIP LOCKED)", async () => {
      const q = createPgQueue(db);
      const seen = new Map<number, number>();
      const handler = async (job: any) =>
        void seen.set(job.payload.n, (seen.get(job.payload.n) ?? 0) + 1);
      const w1 = q.process("batch", handler, { concurrency: 3 });
      const w2 = q.process("batch", handler, { concurrency: 3 });
      for (let n = 0; n < 20; n++) await q.add("batch", { n });
      await waitFor(() => seen.size === 20);
      // every job processed exactly once across both workers — the SKIP LOCKED guarantee
      expect([...seen.values()].every((c) => c === 1)).toBe(true);
      await w1.stop();
      await w2.stop();
    });
  },
);
