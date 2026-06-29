import { describe, it, expect } from "vitest";
import { Heartbeat } from "../src/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Heartbeat (coalescing scheduler)", () => {
  it("fires a task at its interval, and stops on cancel", async () => {
    const hb = new Heartbeat();
    let n = 0;
    const t = hb.every(20, () => n++);
    await sleep(85);
    expect(n).toBeGreaterThanOrEqual(2);
    const at = n;
    t.cancel();
    await sleep(60);
    expect(n).toBe(at); // no more fires after cancel
    hb.stop();
  });

  it("runs multiple tasks at independent cadences (no shared fixed rate)", async () => {
    const hb = new Heartbeat();
    let fast = 0;
    let slow = 0;
    hb.every(15, () => fast++);
    hb.every(70, () => slow++);
    await sleep(160);
    expect(fast).toBeGreaterThan(slow); // fast fires far more often
    expect(slow).toBeGreaterThanOrEqual(1);
    hb.stop();
  });

  it("tracks size and holds no timer when empty", () => {
    const hb = new Heartbeat();
    expect(hb.size).toBe(0);
    const a = hb.every(50, () => {});
    const b = hb.every(50, () => {});
    expect(hb.size).toBe(2);
    a.cancel();
    b.cancel();
    expect(hb.size).toBe(0);
    hb.stop();
  });

  it("retunes a task via setInterval", async () => {
    const hb = new Heartbeat();
    let n = 0;
    const t = hb.every(500, () => n++);
    t.setInterval(15); // speed it up
    await sleep(80);
    expect(n).toBeGreaterThanOrEqual(2);
    hb.stop();
  });

  it("isolates a throwing task from its siblings", async () => {
    const hb = new Heartbeat();
    const spy = console.error;
    console.error = () => {};
    let ok = 0;
    try {
      hb.every(15, () => {
        throw new Error("boom");
      });
      hb.every(15, () => ok++);
      await sleep(70);
    } finally {
      console.error = spy;
    }
    expect(ok).toBeGreaterThanOrEqual(1); // sibling kept firing
    hb.stop();
  });
});
