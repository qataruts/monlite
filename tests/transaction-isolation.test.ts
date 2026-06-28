import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "../src/index";

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("transactionAsync write isolation", () => {
  it("allows in-callback writes but rejects a foreign write during the await window", async () => {
    const db = createDb(":memory:");
    dbs.push(db);
    const c = db.collection<{ balance: number }>("accounts");
    await c.create({ data: { _id: "a", balance: 100 } });

    let foreignErr: unknown;
    const txP = db.transactionAsync(async () => {
      // write from INSIDE the transaction callback — allowed
      await c.update({ where: { _id: "a" }, data: { $inc: { balance: -10 } } });
      await new Promise((r) => setTimeout(r, 60)); // hold the transaction open
    });

    // a foreign write issued while the transaction is awaiting must throw, not
    // silently fold into the transaction
    await new Promise((r) => setTimeout(r, 15));
    try {
      await c.create({ data: { _id: "b", balance: 0 } });
    } catch (e) {
      foreignErr = e;
    }

    await txP;
    expect(foreignErr).toBeTruthy();
    expect(String((foreignErr as Error).message)).toMatch(/transactionAsync/);
    // the in-callback update committed; the foreign insert did not happen
    expect((await c.findFirst({ where: { _id: "a" } }))!.balance).toBe(90);
    expect(await c.findFirst({ where: { _id: "b" } })).toBeNull();
  });

  it("plain writes are unaffected when no async transaction is in flight", async () => {
    const db = createDb(":memory:");
    dbs.push(db);
    const c = db.collection("t");
    await c.create({ data: { _id: "x" } });
    await c.update({ where: { _id: "x" }, data: { $set: { n: 1 } } });
    expect(await c.count()).toBe(1);
  });
});
