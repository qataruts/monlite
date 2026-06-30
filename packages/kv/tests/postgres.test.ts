// @monlite/kv on the Postgres engine: pgKv — namespaced cache, TTL, sorted sets, pub/sub.
// Skips cleanly without a reachable Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "@monlite/postgres";
import { pgKv } from "../src/index";

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

(available ? describe : describe.skip)("@monlite/kv on Postgres", () => {
  let db: any;
  beforeAll(async () => {
    db = createDb(URL);
    for (const t of ["_kv", "_monlite_kv_zset", "_monlite_kv_pubsub"])
      await db.asyncDriver.exec(`DROP TABLE IF EXISTS ${t} CASCADE`);
  });
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it("get/set/incr/setNX/expire/ttl/keys", async () => {
    const c = pgKv(db, { namespace: "t" });
    await c.set("a", { x: 1 });
    expect(await c.get("a")).toEqual({ x: 1 });
    expect(await c.has("a")).toBe(true);
    expect(await c.get("missing")).toBeUndefined();

    expect(await c.incr("n")).toBe(1);
    expect(await c.incr("n", 4)).toBe(5);
    expect(await c.decr("n", 2)).toBe(3);

    // setNX: first wins, second is a no-op
    expect(await c.setNX("lock", 1)).toBe(true);
    expect(await c.setNX("lock", 2)).toBe(false);
    expect(await c.get("lock")).toBe(1);

    // ttl
    await c.set("e", "v", { ttl: 10_000 });
    expect(await c.ttl("e")).toBeGreaterThan(0);
    expect(await c.ttl("a")).toBe(-1); // no expiry
    expect(await c.ttl("nope")).toBe(-2); // absent

    expect((await c.keys()).sort()).toContain("a");
    expect(await c.delete("a")).toBe(true);
    expect(await c.has("a")).toBe(false);
  });

  it("sorted sets (zadd/zincrby/zrange/zrank)", async () => {
    const c = pgKv(db, { namespace: "z" });
    await c.zadd("board", 10, "alice");
    await c.zadd("board", 30, "bob");
    await c.zadd("board", 20, "cara");
    expect(await c.zcard("board")).toBe(3);
    expect(await c.zscore("board", "bob")).toBe(30);
    expect(await c.zincrby("board", 5, "alice")).toBe(15);
    // ascending by score
    expect(await c.zrange("board", 0, -1)).toEqual(["alice", "cara", "bob"]);
    // descending (top 2)
    expect(await c.zrange("board", 0, 1, { rev: true })).toEqual(["bob", "cara"]);
    expect(await c.zrank("board", "bob", { rev: true })).toBe(0); // highest score
    expect(await c.zrangeByScore("board", 15, 20)).toEqual(["alice", "cara"]);
  });

  it("pub/sub delivers cross-namespace-isolated messages", async () => {
    const c = pgKv(db, { namespace: "ps", pubsubPollMs: 30 });
    const got: any[] = [];
    const unsub = c.subscribe("news", (m) => got.push(m));
    await new Promise((r) => setTimeout(r, 60)); // let the cursor snapshot land
    await c.publish("news", { headline: "hi" });
    await c.publish("other", { x: 1 }); // different channel → ignored
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([{ headline: "hi" }]);
    unsub();
    c.stop();
  });
});
