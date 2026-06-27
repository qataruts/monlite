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

const schema = { amount: "REAL", status: "TEXT" } as const;

describe("structured-collection sync", () => {
  it("syncs native-column documents end to end (columns preserved)", async () => {
    const hub = db("HUB");
    const a = db("A");
    const b = db("B");
    // Contract: open structured collections with their schema before syncing.
    a.collection("orders", { schema });
    b.collection("orders", { schema });
    hub.collection("orders", { schema });

    const ea = sync(a, {
      adapter: new MonliteAdapter(hub),
      collections: ["orders"],
    });
    const eb = sync(b, {
      adapter: new MonliteAdapter(hub),
      collections: ["orders"],
    });

    await a.collection("orders").create({
      data: { _id: "o1", amount: 100, status: "paid", note: "overflow" },
    });
    await ea.start(); // push to hub
    await eb.start(); // pull to b

    const got = await b.collection("orders").findById("o1");
    expect(got).toMatchObject({
      amount: 100,
      status: "paid",
      note: "overflow",
    });

    // The value is stored in a REAL column on B, not just JSON overflow.
    const raw = b.sqlite
      .prepare(`SELECT amount, status, data FROM orders WHERE _id = ?`)
      .get("o1") as { amount: number; status: string; data: string };
    expect(raw.amount).toBe(100);
    expect(raw.status).toBe("paid");
    expect(JSON.parse(raw.data)).toEqual({ note: "overflow" });
  });

  it("propagates structured updates and deletes", async () => {
    const hub = db("HUB");
    const a = db("A");
    const b = db("B");
    for (const d of [a, b, hub]) d.collection("orders", { schema });

    const ea = sync(a, {
      adapter: new MonliteAdapter(hub),
      collections: ["orders"],
    });
    const eb = sync(b, {
      adapter: new MonliteAdapter(hub),
      collections: ["orders"],
    });

    await a
      .collection("orders")
      .create({ data: { _id: "o1", amount: 10, status: "new" } });
    await ea.start();
    await eb.start();

    await a
      .collection("orders")
      .update({ where: { _id: "o1" }, data: { amount: 25 } });
    await ea.sync();
    await eb.sync();
    expect((await b.collection("orders").findById("o1"))!.amount).toBe(25);

    await a.collection("orders").delete({ where: { _id: "o1" } });
    await ea.sync();
    await eb.sync();
    expect(await b.collection("orders").findById("o1")).toBeNull();
  });
});
