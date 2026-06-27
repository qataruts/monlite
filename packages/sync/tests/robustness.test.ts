import { describe, it, expect, afterEach } from "vitest";
import { makeVersion, type Monlite } from "@monlite/core";
import {
  sync,
  MemoryAdapter,
  type SyncAdapter,
  type Cursor,
  type PullOptions,
  type PullResult,
  type PushResult,
  type LocalChange,
} from "../src/index";
import { openSyncDb } from "./helper";

const dbs: Monlite[] = [];
function db(nodeId: string): Monlite {
  const d = openSyncDb(nodeId);
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

/** Wraps a MemoryAdapter, throwing on the first N push/pull attempts. */
class FlakyAdapter implements SyncAdapter {
  readonly name = "flaky";
  private failPush: number;
  private failPull: number;
  pushCalls = 0;
  pullCalls = 0;
  constructor(
    private readonly inner: MemoryAdapter,
    opts: { failPush?: number; failPull?: number } = {},
  ) {
    this.failPush = opts.failPush ?? 0;
    this.failPull = opts.failPull ?? 0;
  }
  async pull(cursor: Cursor, opts: PullOptions): Promise<PullResult> {
    this.pullCalls++;
    if (this.failPull-- > 0) throw new Error("transient pull");
    return this.inner.pull(cursor, opts);
  }
  async push(changes: LocalChange[]): Promise<PushResult> {
    this.pushCalls++;
    if (this.failPush-- > 0) throw new Error("transient push");
    return this.inner.push(changes);
  }
}

describe("engine: robustness (retry + partial failure)", () => {
  it("retries a transient push failure and still delivers", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const flaky = new FlakyAdapter(mem, { failPush: 2 });
    const engine = sync(a, { adapter: flaky, mode: "push", retryBaseMs: 2 });
    await a.collection("users").create({ data: { _id: "u1", name: "Ali" } });

    await engine.start(); // push throws twice, third attempt succeeds
    expect(mem.snapshot()).toHaveLength(1);
    expect(engine.status().pendingPush).toBe(0);
    expect(flaky.pushCalls).toBe(3); // 2 failed + 1 success
  });

  it("retries a transient pull failure and applies remote changes", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    mem.ingestRemote([
      {
        collection: "users",
        _id: "r1",
        op: "upsert",
        version: makeVersion(Date.now(), "B"),
        doc: { _id: "r1", name: "Remote" },
      },
    ]);
    const flaky = new FlakyAdapter(mem, { failPull: 2 });
    const engine = sync(a, { adapter: flaky, mode: "pull", retryBaseMs: 2 });

    await engine.start();
    expect(await a.collection("users").findById("r1")).toMatchObject({
      name: "Remote",
    });
    expect(flaky.pullCalls).toBe(3);
  });

  it("preserves pending changes when retries are exhausted (no data loss)", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const flaky = new FlakyAdapter(mem, { failPush: 99 });
    const engine = sync(a, {
      adapter: flaky,
      mode: "push",
      retries: 1,
      retryBaseMs: 1,
    });
    await a.collection("users").create({ data: { _id: "u1", name: "Ali" } });

    await expect(engine.start()).rejects.toThrow(/transient push/);
    expect(flaky.pushCalls).toBe(2); // initial + 1 retry, then give up
    expect(mem.snapshot()).toHaveLength(0); // nothing reached the remote
    expect(engine.status().pendingPush).toBe(1); // still queued for next round
  });

  it("emits a retry event per failed attempt", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const flaky = new FlakyAdapter(mem, { failPush: 2 });
    const engine = sync(a, { adapter: flaky, mode: "push", retryBaseMs: 1 });
    const events: Array<{ label: string; attempt: number }> = [];
    engine.on("retry", (e) => events.push(e));
    await a.collection("users").create({ data: { _id: "u1", name: "Ali" } });

    await engine.start();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ label: "push", attempt: 1 });
    expect(events[1]).toMatchObject({ label: "push", attempt: 2 });
  });

  it("re-pushes changes the remote did not ack (partial ack)", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    let firstPush = true;
    const partial: SyncAdapter = {
      name: "partial",
      pull: (c, o) => mem.pull(c, o),
      async push(changes) {
        if (firstPush && changes.length > 1) {
          firstPush = false;
          return mem.push(changes.slice(0, 1)); // ack only one, drop the rest
        }
        return mem.push(changes);
      },
    };
    const engine = sync(a, { adapter: partial, mode: "push" });
    await a.collection("users").createMany({
      data: [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }],
    });

    await engine.start(); // first round acks only one
    expect(mem.snapshot()).toHaveLength(1);
    expect(engine.status().pendingPush).toBe(2);

    await engine.sync(); // next round drains the rest
    expect(mem.snapshot()).toHaveLength(3);
    expect(engine.status().pendingPush).toBe(0);
  });
});
