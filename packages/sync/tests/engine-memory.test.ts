import { describe, it, expect, afterEach } from "vitest";
import { makeVersion, type Monlite } from "@monlite/core";
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

describe("engine: push (M3)", () => {
  it("pushes local docs to the remote", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const engine = sync(a, { adapter: mem, mode: "two-way" });
    await a.collection("users").create({ data: { name: "Ali" } });

    await engine.start();

    expect(mem.snapshot()).toHaveLength(1);
    expect(mem.snapshot()[0].doc).toMatchObject({ name: "Ali" });
    expect(engine.status().pendingPush).toBe(0);
  });
});

describe("engine: pull (M2)", () => {
  it("applies remote changes locally", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const engine = sync(a, { adapter: mem, mode: "pull" });
    mem.ingestRemote([
      {
        collection: "users",
        _id: "r1",
        op: "upsert",
        version: makeVersion(Date.now(), "B"),
        doc: { _id: "r1", name: "Remote" },
      },
    ]);

    await engine.start();

    expect(await a.collection("users").findById("r1")).toMatchObject({
      name: "Remote",
    });
  });
});

describe("engine: two-way convergence (M3)", () => {
  it("two clients converge through a shared hub", async () => {
    const a = db("A");
    const b = db("B");
    const mem = new MemoryAdapter();
    const ea = sync(a, { adapter: mem });
    const eb = sync(b, { adapter: mem });

    await a.collection("docs").create({ data: { _id: "d1", who: "a" } });
    await b.collection("docs").create({ data: { _id: "d2", who: "b" } });

    await ea.start(); // push d1
    await eb.start(); // pull d1, push d2
    await ea.sync(); // pull d2

    expect(await a.collection("docs").findById("d2")).toMatchObject({ who: "b" });
    expect(await b.collection("docs").findById("d1")).toMatchObject({ who: "a" });
  });
});

describe("engine: conflicts (M4)", () => {
  it("last-write-wins; newer remote overwrites local", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const engine = sync(a, { adapter: mem });
    await a.collection("docs").create({ data: { _id: "x", v: "local" } });
    mem.ingestRemote([
      {
        collection: "docs",
        _id: "x",
        op: "upsert",
        version: makeVersion(Date.now() + 10_000, "B"),
        doc: { _id: "x", v: "remote" },
      },
    ]);

    await engine.start();

    expect((await a.collection("docs").findById("x"))!.v).toBe("remote");
    expect(a.$sync!.conflicts().length).toBeGreaterThan(0);
  });

  it("custom resolver can force local to win", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const engine = sync(a, {
      adapter: mem,
      conflict: () => "local",
    });
    await a.collection("docs").create({ data: { _id: "x", v: "local" } });
    mem.ingestRemote([
      {
        collection: "docs",
        _id: "x",
        op: "upsert",
        version: makeVersion(Date.now() + 10_000, "B"),
        doc: { _id: "x", v: "remote" },
      },
    ]);

    await engine.start();
    expect((await a.collection("docs").findById("x"))!.v).toBe("local");
  });
});

describe("engine: delete propagation / tombstones (M3)", () => {
  it("deletes propagate to other clients", async () => {
    const a = db("A");
    const b = db("B");
    const mem = new MemoryAdapter();
    const ea = sync(a, { adapter: mem });
    const eb = sync(b, { adapter: mem });

    await a.collection("docs").create({ data: { _id: "d1", n: 1 } });
    await ea.start(); // push d1
    await eb.start(); // pull d1
    expect(await b.collection("docs").findById("d1")).toBeTruthy();

    await a.collection("docs").delete({ where: { _id: "d1" } });
    await ea.sync(); // push delete
    await eb.sync(); // pull delete

    expect(await b.collection("docs").findById("d1")).toBeNull();
  });
});

describe("engine: live / watch (M4)", () => {
  it("applies remote changes as they stream in", async () => {
    const a = db("A");
    const mem = new MemoryAdapter();
    const engine = sync(a, { adapter: mem, live: true });
    await engine.start();

    mem.ingestRemote([
      {
        collection: "docs",
        _id: "L1",
        op: "upsert",
        version: makeVersion(Date.now(), "B"),
        doc: { _id: "L1", x: 1 },
      },
    ]);

    expect(await a.collection("docs").findById("L1")).toMatchObject({ x: 1 });
    await engine.stop();
  });
});
