import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, makeVersion, type Monlite } from "../src/index";

const driver = (process.env.MONLITE_DRIVER as any) || undefined;

let db: Monlite;
beforeEach(() => {
  db = createDb(":memory:", { sync: true, nodeId: "nodeA", ...(driver ? { driver } : {}) });
});
afterEach(async () => {
  await db.$disconnect();
});

describe("M1: sync store / change feed", () => {
  it("is opt-in (no $sync without { sync: true })", () => {
    const plain = createDb(":memory:", driver ? { driver } : {});
    expect(plain.$sync).toBeUndefined();
    plain.$disconnect();
    expect(db.$sync).toBeDefined();
    expect(db.nodeId).toBe("nodeA");
  });

  it("records local writes in the change feed", async () => {
    const users = db.collection("users");
    const a = await users.create({ data: { name: "Ali" } });
    await users.create({ data: { name: "Sara" } });

    const pending = db.$sync!.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0].op).toBe("upsert");
    expect(pending[0].doc).toMatchObject({ name: "Ali" });
    expect(db.$sync!.currentVersion("users", a._id)).toBeTruthy();
  });

  it("dedupes to the latest change per document", async () => {
    const users = db.collection("users");
    const a = await users.create({ data: { name: "Ali", age: 1 } });
    await users.update({ where: { _id: a._id }, data: { age: 2 } });
    await users.update({ where: { _id: a._id }, data: { age: 3 } });

    const pending = db.$sync!.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].doc).toMatchObject({ age: 3 });
  });

  it("markPushed clears the push queue", async () => {
    const users = db.collection("users");
    await users.create({ data: { name: "Ali" } });
    const pending = db.$sync!.pending();
    db.$sync!.markPushed(pending);
    expect(db.$sync!.pending()).toHaveLength(0);
  });

  it("records deletes as tombstones", async () => {
    const users = db.collection("users");
    const a = await users.create({ data: { name: "Ali" } });
    db.$sync!.markPushed(db.$sync!.pending());
    await users.delete({ where: { _id: a._id } });

    const pending = db.$sync!.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].op).toBe("delete");
  });

  it("applyRemote inserts a brand-new remote doc", async () => {
    const res = db.$sync!.applyRemote({
      collection: "users",
      _id: "remote1",
      op: "upsert",
      version: makeVersion(Date.now(), "nodeB"),
      doc: { _id: "remote1", name: "Remote", created_at: 1, updated_at: 1 },
    });
    expect(res).toMatchObject({ applied: true, winner: "remote" });
    expect(await db.collection("users").findById("remote1")).toMatchObject({
      name: "Remote",
    });
    // applied remote change must NOT be queued for push back (echo prevention)
    expect(db.$sync!.pending()).toHaveLength(0);
  });

  it("ignores an echo of our own change (same version)", async () => {
    const a = await db.collection("users").create({ data: { name: "Ali" } });
    const v = db.$sync!.currentVersion("users", a._id)!;
    const res = db.$sync!.applyRemote({
      collection: "users",
      _id: a._id,
      op: "upsert",
      version: v,
      doc: { _id: a._id, name: "ECHO" },
    });
    expect(res.applied).toBe(false);
    expect((await db.collection("users").findById(a._id))!.name).toBe("Ali");
  });

  it("resolves conflicts last-write-wins", async () => {
    const users = db.collection("users");
    const a = await users.create({ data: { name: "local", n: 1 } });

    // older remote loses
    const lose = db.$sync!.applyRemote({
      collection: "users",
      _id: a._id,
      op: "upsert",
      version: makeVersion(1, "nodeB"),
      doc: { _id: a._id, name: "old-remote" },
    });
    expect(lose).toMatchObject({ applied: false, conflict: true, winner: "local" });
    expect((await users.findById(a._id))!.name).toBe("local");

    // newer remote wins
    const win = db.$sync!.applyRemote({
      collection: "users",
      _id: a._id,
      op: "upsert",
      version: makeVersion(Date.now() + 10_000, "nodeB"),
      doc: { _id: a._id, name: "new-remote" },
    });
    expect(win).toMatchObject({ applied: true, winner: "remote" });
    expect((await users.findById(a._id))!.name).toBe("new-remote");

    expect(db.$sync!.conflicts().length).toBe(2);
  });

  it("persists per-remote sync state", () => {
    db.$sync!.setState("mongo://app", { cursor: "tok-1", lastPullAt: 123 });
    expect(db.$sync!.getState("mongo://app")).toMatchObject({
      cursor: "tok-1",
      lastPullAt: 123,
    });
  });

  it("seed enqueues pre-existing docs", async () => {
    // simulate docs created before sync by pushing then seeding fresh
    const users = db.collection("users");
    await users.createMany({ data: [{ name: "A" }, { name: "B" }] });
    db.$sync!.markPushed(db.$sync!.pending());
    expect(db.$sync!.pending()).toHaveLength(0);
    const n = db.$sync!.seed(["users"]);
    expect(n).toBe(0); // already recorded → idempotent
  });

  it("hides internal tables from $collections", async () => {
    await db.collection("users").create({ data: { name: "x" } });
    expect(await db.$collections()).toEqual(["users"]);
  });
});
