import { describe, it, expect, afterEach } from "vitest";
import { type Monlite } from "@monlite/core";
import { sync, MemoryAdapter } from "../src/index";
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

describe("sync hardening", () => {
  it("rejects an unknown conflict strategy", () => {
    const a = db("A");
    expect(() =>
      sync(a, { adapter: new MemoryAdapter(), conflict: "bogus" as any }),
    ).toThrow();
  });

  it("assigns unique versions even within the same millisecond", async () => {
    const a = db("A");
    await a
      .collection("c")
      .createMany({ data: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    const versions = a.$sync!.pending().map((p) => p.version);
    expect(new Set(versions).size).toBe(3);
  });

  it("drains a large backlog over multiple rounds via batchSize", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const engine = sync(a, { adapter: mem, mode: "push", batchSize: 2 });
    await a.collection("c").createMany({
      data: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
    });

    await engine.start(); // pushes first batch of 2
    expect(mem.snapshot()).toHaveLength(2);
    await engine.sync();
    await engine.sync();
    expect(mem.snapshot()).toHaveLength(5);
    expect(engine.status().pendingPush).toBe(0);
  });

  it("does not crash on an error with no listener attached", async () => {
    const a = db("A");
    const brokenAdapter = {
      name: "broken",
      async pull() {
        throw new Error("boom");
      },
      async push() {
        return { acked: [] };
      },
    };
    const engine = sync(a, { adapter: brokenAdapter as any, mode: "pull" });
    // No 'error' listener attached; start() runs a round that throws internally.
    await expect(engine.start()).rejects.toThrow("boom");
    await engine.stop();
  });
});
