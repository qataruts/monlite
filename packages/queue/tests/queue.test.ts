import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { createQueue, type Queue } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dbs: Monlite[] = [];
const queues: Queue[] = [];
function open(): Monlite {
  const d = createDb(":memory:", driver ? { driver } : {});
  dbs.push(d);
  return d;
}
function makeQueue(...args: Parameters<typeof createQueue>): Queue {
  const q = createQueue(...args);
  queues.push(q);
  return q;
}
const waitFor = async (fn: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error("waitFor timed out");
};
afterEach(async () => {
  while (queues.length) await queues.pop()!.close();
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("@monlite/queue", () => {
  it("processes a job, stores the result, emits completed", async () => {
    const q = makeQueue(open());
    const results: number[] = [];
    q.on("completed", (_job, r) => results.push(r));
    q.process<{ a: number; b: number }, number>(
      "sum",
      (job) => job.payload.a + job.payload.b,
    );
    const job = q.add("sum", { a: 2, b: 3 });
    await waitFor(() => q.getJob(job.id)?.status === "done");
    expect(q.getJob(job.id)!.result).toBe(5);
    expect(results).toEqual([5]);
  });

  it("respects delay (job not run until due)", async () => {
    const q = makeQueue(open());
    q.process("x", () => "ok", { pollInterval: 10 });
    const job = q.add("x", 1, { delay: 100 });
    await sleep(30);
    expect(q.getJob(job.id)!.status).toBe("pending");
    await waitFor(() => q.getJob(job.id)!.status === "done");
  });

  it("runs higher priority first", async () => {
    const q = makeQueue(open());
    q.add("p", "low", { priority: 1 });
    q.add("p", "high", { priority: 10 });
    q.add("p", "mid", { priority: 5 });
    const order: string[] = [];
    q.process<string>("p", (job) => void order.push(job.payload), {
      concurrency: 1,
      pollInterval: 5,
    });
    await waitFor(() => order.length === 3);
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("retries with backoff then succeeds", async () => {
    const q = makeQueue(open(), { maxAttempts: 3, backoff: () => 5 });
    let calls = 0;
    q.process(
      "r",
      () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { pollInterval: 5 },
    );
    const job = q.add("r", 1);
    await waitFor(() => q.getJob(job.id)!.status === "done");
    expect(calls).toBe(3);
    expect(q.getJob(job.id)!.attempts).toBe(3);
  });

  it("dead-letters after maxAttempts", async () => {
    const q = makeQueue(open(), { maxAttempts: 2, backoff: () => 5 });
    const failures: string[] = [];
    q.on("failed", (_job, err) => failures.push(err.message));
    q.process(
      "d",
      () => {
        throw new Error("nope");
      },
      { pollInterval: 5 },
    );
    const job = q.add("d", 1);
    await waitFor(() => q.getJob(job.id)!.status === "failed");
    expect(q.getJob(job.id)!.attempts).toBe(2);
    expect(failures).toEqual(["nope", "nope"]);
  });

  it("honours concurrency", async () => {
    const q = makeQueue(open());
    let active = 0;
    let peak = 0;
    q.process(
      "c",
      async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(20);
        active--;
      },
      { concurrency: 3, pollInterval: 5 },
    );
    for (let i = 0; i < 6; i++) q.add("c", i);
    await waitFor(() => q.counts("c").done === 6);
    expect(peak).toBe(3);
  });

  it("counts by status and recovers stuck jobs", () => {
    const db = open();
    const q = makeQueue(db);
    const job = q.add("z", 1);
    expect(q.counts("z")).toMatchObject({ pending: 1 });
    db.driver
      .prepare(`UPDATE _jobs SET status='active', updated_at=? WHERE id=?`)
      .run(Date.now() - 120_000, job.id);
    expect(q.recover(60_000)).toBe(1);
    expect(q.getJob(job.id)!.status).toBe("pending");
  });

  it("removeOnComplete deletes finished jobs", async () => {
    const q = makeQueue(open(), { removeOnComplete: true });
    q.process("rm", () => "x", { pollInterval: 5 });
    const job = q.add("rm", 1);
    await waitFor(() => q.getJob(job.id) === undefined);
  });

  it("dedupes by jobId (idempotent enqueue)", () => {
    const q = makeQueue(open());
    const a = q.add("sync", { n: 1 }, { jobId: "task-7" });
    const b = q.add("sync", { n: 2 }, { jobId: "task-7" }); // deduped → same job
    expect(b.id).toBe(a.id);
    expect(b.jobId).toBe("task-7");
    expect(q.counts("sync").pending).toBe(1);
    // a different jobId enqueues a new job
    const c = q.add("sync", { n: 3 }, { jobId: "task-8" });
    expect(c.id).not.toBe(a.id);
    expect(q.counts("sync").pending).toBe(2);
  });
});

describe("visibility timeout (reaper + heartbeat)", () => {
  it("reclaims a crashed worker's job and reprocesses it", async () => {
    const db = open();
    const q = createQueue(db, { maxAttempts: 5 });
    queues.push(q);
    const job = q.add("t", { x: 1 });

    // simulate a crashed worker: claim the job (active), then make it stale
    const claimed = (q as any).claimInternal("t");
    expect(claimed?.id).toBe(job.id);
    db.sqlite
      .prepare("UPDATE _jobs SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 30_000, job.id);

    // a worker with a visibility timeout reaps the stale job and runs it
    let ran = false;
    const w = q.process("t", async () => { ran = true; }, {
      visibilityTimeout: 2000,
      pollInterval: 100,
    });
    await sleep(2200); // reaper fires at ~vt/2 = 1000ms, then the job runs
    await w.stop();

    expect(ran).toBe(true);
    expect(q.getJob(job.id)?.status).toBe("done");
  }, 10_000);
});

describe("reaper is scoped to its own queue", () => {
  it("a queue-A reaper does not reclaim queue-B's in-flight job", async () => {
    const db = open();
    const q = createQueue(db);
    queues.push(q);
    const jobB = q.add("B", { x: 1 });
    const claimed = (q as any).claimInternal("B"); // B has a stale active job
    expect(claimed?.id).toBe(jobB.id);
    db.sqlite.prepare("UPDATE _jobs SET updated_at = ? WHERE id = ?").run(Date.now() - 30_000, jobB.id);
    const w = q.process("A", async () => {}, { visibilityTimeout: 2000, pollInterval: 100 });
    await sleep(1500); // A's reaper fires (~1000ms)
    await w.stop();
    expect(q.getJob(jobB.id)?.status).toBe("active"); // untouched
  }, 10_000);
});

describe("fencing: a reclaimed job rejects the original worker's stale write", () => {
  it("completeInternal/failInternal no-op once attempts bumped by a reclaim", async () => {
    const db = open();
    const q = createQueue(db);
    queues.push(q);
    const added = q.add("x", { n: 1 });
    const a = (q as any).claimInternal("x"); // worker A claims (attempts=1)
    expect(a.attempts).toBe(1);
    // reaper resets A's stuck job; worker B reclaims it (attempts=2)
    db.sqlite.prepare("UPDATE _jobs SET status='pending', locked_by=NULL WHERE id=?").run(added.id);
    const b = (q as any).claimInternal("x");
    expect(b.attempts).toBe(2);
    // A revives → its stale completion is fenced out, B's lands
    expect((q as any).completeInternal(a, "A")).toBe(false);
    expect(q.getJob(added.id)?.status).toBe("active");
    expect((q as any).heartbeatInternal(added.id, a.attempts)).toBeUndefined(); // stale hb: no-op
    expect((q as any).completeInternal(b, "B")).toBe(true);
    const done = q.getJob(added.id);
    expect(done?.status).toBe("done");
    expect(done?.result).toBe("B");
  });
});
