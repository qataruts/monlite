import { describe, it, expect, afterEach } from "vitest";
import { type Monlite } from "@monlite/core";
import { sync, MonliteAdapter } from "../src/index";
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

describe("MonliteAdapter (M5: second real adapter)", () => {
  it("requires a sync-enabled remote", () => {
    const plain = openSyncDb("X"); // has $sync
    expect(() => new MonliteAdapter(plain)).not.toThrow();
  });

  it("pushes local docs into the remote monlite db", async () => {
    const local = db("A");
    const remote = db("HUB");
    const engine = sync(local, { adapter: new MonliteAdapter(remote) });

    await local.collection("docs").createMany({
      data: [
        { _id: "1", n: 1 },
        { _id: "2", n: 2 },
      ],
    });
    await engine.start();

    expect(await remote.collection("docs").count()).toBe(2);
  });

  it("pulls remote-origin edits down to the local db", async () => {
    const local = db("A");
    const remote = db("HUB");
    const engine = sync(local, { adapter: new MonliteAdapter(remote) });
    await engine.start();

    await remote.collection("docs").create({ data: { _id: "3", n: 3 } });
    await engine.sync();

    expect(await local.collection("docs").findById("3")).toMatchObject({ n: 3 });
  });

  it("two locals converge through a monlite hub (two-way)", async () => {
    const a = db("A");
    const b = db("B");
    const hub = db("HUB");
    const ea = sync(a, { adapter: new MonliteAdapter(hub) });
    const eb = sync(b, { adapter: new MonliteAdapter(hub) });

    await a.collection("docs").create({ data: { _id: "d1", who: "a" } });
    await b.collection("docs").create({ data: { _id: "d2", who: "b" } });

    await ea.start();
    await eb.start();
    await ea.sync();

    expect(await a.collection("docs").findById("d2")).toMatchObject({ who: "b" });
    expect(await b.collection("docs").findById("d1")).toMatchObject({ who: "a" });
    expect(await hub.collection("docs").count()).toBe(2);
  });

  it("propagates deletes through the hub", async () => {
    const a = db("A");
    const b = db("B");
    const hub = db("HUB");
    const ea = sync(a, { adapter: new MonliteAdapter(hub) });
    const eb = sync(b, { adapter: new MonliteAdapter(hub) });

    await a.collection("docs").create({ data: { _id: "d1", n: 1 } });
    await ea.start();
    await eb.start();
    expect(await b.collection("docs").findById("d1")).toBeTruthy();

    await a.collection("docs").delete({ where: { _id: "d1" } });
    await ea.sync();
    await eb.sync();

    expect(await b.collection("docs").findById("d1")).toBeNull();
  });
});
