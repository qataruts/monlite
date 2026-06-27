import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { kv } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dbs: Monlite[] = [];
function open(): Monlite {
  const d = createDb(":memory:", driver ? { driver } : {});
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
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
