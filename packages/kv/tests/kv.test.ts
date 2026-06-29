import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { kv } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
};

const dbs: Monlite[] = [];
const dirs: string[] = [];
function open(): Monlite {
  const d = createDb(":memory:", driver ? { driver } : {});
  dbs.push(d);
  return d;
}
afterEach(async () => {
  // Disconnect first so Windows releases the file handle before we unlink.
  while (dbs.length) await dbs.pop()!.$disconnect();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("@monlite/kv", () => {
  it("get/set/has/delete (synchronous, any JSON value)", () => {
    const c = kv(open());
    expect(c.get("missing")).toBeUndefined();
    c.set("a", { user: "ali", roles: ["admin"] });
    expect(c.get("a")).toEqual({ user: "ali", roles: ["admin"] });
    expect(c.has("a")).toBe(true);
    expect(c.delete("a")).toBe(true);
    expect(c.has("a")).toBe(false);
  });

  it("TTL: ttl() conventions and expiry", async () => {
    const c = kv(open());
    c.set("perm", 1);
    expect(c.ttl("perm")).toBe(-1); // no expiry
    expect(c.ttl("nope")).toBe(-2); // absent

    c.set("temp", 1, { ttl: 50_000 });
    expect(c.ttl("temp")).toBeGreaterThan(0);

    c.expire("temp", -100); // expire in the past
    expect(c.get("temp")).toBeUndefined();

    c.set("short", 1, { ttl: 15 });
    await sleep(40);
    expect(c.get("short")).toBeUndefined();
  });

  it("incr/decr atomically", () => {
    const c = kv(open());
    expect(c.incr("n")).toBe(1);
    expect(c.incr("n", 5)).toBe(6);
    expect(c.decr("n", 2)).toBe(4);
    c.set("s", "hello");
    expect(() => c.incr("s")).toThrow();
  });

  it("mget, keys (with prefix), size, flush", () => {
    const c = kv(open());
    c.set("user:1", "a");
    c.set("user:2", "b");
    c.set("post:1", "c");
    expect(c.mget(["user:1", "post:1", "x"])).toEqual(["a", "c", undefined]);
    expect(c.keys("user:").sort()).toEqual(["user:1", "user:2"]);
    expect(c.size()).toBe(3);
    c.flush();
    expect(c.size()).toBe(0);
  });

  it("namespaces are isolated in one database", () => {
    const db = open();
    const a = kv(db, { namespace: "a" });
    const b = kv(db, { namespace: "b" });
    a.set("k", 1);
    b.set("k", 2);
    expect(a.get("k")).toBe(1);
    expect(b.get("k")).toBe(2);
    expect(a.keys()).toEqual(["k"]);
    expect(b.size()).toBe(1);
  });

  it("sweep timer purges expired keys", async () => {
    const c = kv(open(), { sweepIntervalMs: 20 });
    c.set("x", 1, { ttl: 10 });
    await sleep(60);
    expect(c.size()).toBe(0); // swept
    c.stop();
  });

  it("setNX acquires only when absent or expired (lock primitive)", () => {
    const c = kv(open());
    expect(c.setNX("lock", "a")).toBe(true); // acquired
    expect(c.setNX("lock", "b")).toBe(false); // already held
    expect(c.get("lock")).toBe("a");

    c.expire("lock", -10); // lease expired
    expect(c.setNX("lock", "c")).toBe(true); // re-acquirable
    expect(c.get("lock")).toBe("c");
  });
});

describe("kv edge cases (swarm-found)", () => {
  it("set(key, undefined) stores null instead of throwing", () => {
    const c = kv(open());
    expect(() => c.set("k", undefined)).not.toThrow();
    expect(c.get("k")).toBeNull();
    expect(c.has("k")).toBe(true);
  });
  it("preserves falsy values (0, empty string, false)", () => {
    const c = kv(open());
    c.set("n", 0);
    c.set("s", "");
    c.set("b", false);
    expect(c.get("n")).toBe(0);
    expect(c.get("s")).toBe("");
    expect(c.get("b")).toBe(false);
  });
});

describe("kv pub/sub (paradigm improvements)", () => {
  it("delivers to same-channel subscribers, filters others, no replay", async () => {
    const c = kv(open());
    const got: any[] = [];
    const un = c.subscribe("news", (m) => got.push(m));
    expect(c.publish("news", { hello: "world" })).toBe(1); // 1 local listener
    c.publish("other", { x: 1 }); // different channel
    await sleep(20);
    expect(got).toEqual([{ hello: "world" }]);
    // unsubscribe → no more delivery
    un();
    c.publish("news", { after: "unsub" });
    await sleep(20);
    expect(got).toHaveLength(1);
    // late subscriber does not replay past messages
    c.publish("news", { past: true });
    const late: any[] = [];
    c.subscribe("news", (m) => late.push(m));
    await sleep(20);
    expect(late).toHaveLength(0);
  });

  it("fans out to multiple subscribers on a channel", async () => {
    const c = kv(open());
    const a: any[] = [];
    const b: any[] = [];
    c.subscribe("room", (m) => a.push(m));
    c.subscribe("room", (m) => b.push(m));
    c.publish("room", { hi: 1 });
    await sleep(20);
    expect(a).toEqual([{ hi: 1 }]);
    expect(b).toEqual([{ hi: 1 }]);
  });

  it("delivers across processes (separate connections, same file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kvps-"));
    dirs.push(dir); // cleaned in afterEach, after the dbs are disconnected
    const file = join(dir, "ps.db");
    const dbA = createDb(file, driver ? { driver } : {});
    const dbB = createDb(file, driver ? { driver } : {});
    dbs.push(dbA, dbB);
    const A = kv(dbA, { pubsubPollMs: 30 });
    const B = kv(dbB, { pubsubPollMs: 30 });
    const recv: any[] = [];
    A.subscribe("events", (m) => recv.push(m));
    await sleep(50);
    B.publish("events", { from: "B" });
    await waitFor(() => recv.length >= 1);
    expect(recv).toEqual([{ from: "B" }]);
    A.stop();
    B.stop();
  });
});
