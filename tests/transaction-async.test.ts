import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite, type MonliteOptions } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const dbs: Monlite[] = [];
function open(): Monlite {
  const d = createDb(":memory:", driver ? { driver } : {});
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("transactionAsync (async unit-of-work)", () => {
  it("commits an async read → compute → write atomically (with read-your-writes)", async () => {
    const db = open();
    await db.collection("acct").createMany({
      data: [
        { _id: "A", bal: 100 },
        { _id: "B", bal: 0 },
      ],
    });

    await db.transactionAsync(async (tx) => {
      const a = await tx.collection("acct").findById("A");
      await Promise.resolve(); // an await inside the transaction
      await tx
        .collection("acct")
        .update({ where: { _id: "A" }, data: { bal: a.bal - 50 } });
      await tx
        .collection("acct")
        .update({ where: { _id: "B" }, data: { bal: 50 } });
      // read-your-writes: the staged write is visible inside the same tx
      expect((await tx.collection("acct").findById("A")).bal).toBe(50);
    });

    expect((await db.collection("acct").findById("A")).bal).toBe(50);
    expect((await db.collection("acct").findById("B")).bal).toBe(50);
  });

  it("rolls the whole unit back on a mid-posting throw", async () => {
    const db = open();
    await db.collection("acct").create({ data: { _id: "A", bal: 100 } });
    await db.collection("ledger").create({ data: { _id: "seed", amt: 0 } }); // tables exist up front

    await expect(
      db.transactionAsync(async (tx) => {
        await tx
          .collection("acct")
          .update({ where: { _id: "A" }, data: { bal: 0 } }); // debit
        await tx.collection("ledger").create({ data: { amt: 100 } });
        throw new Error("boom"); // the credit never happens
      }),
    ).rejects.toThrow("boom");

    expect((await db.collection("acct").findById("A")).bal).toBe(100); // debit undone
    expect(await db.collection("ledger").count()).toBe(1); // only the seed; the +100 entry undone
  });

  it("serializes concurrent async transactions — no lost update", async () => {
    const db = open();
    await db.collection("acct").create({ data: { _id: "a", balance: 0 } });

    const increment = () =>
      db.transactionAsync(async (tx) => {
        const a = await tx.collection("acct").findById("a");
        await new Promise((r) => setTimeout(r, 5)); // widen the interleave window
        await tx
          .collection("acct")
          .update({ where: { _id: "a" }, data: { balance: a.balance + 1 } });
      });

    await Promise.all([increment(), increment(), increment()]);
    // Without serialization, all three would read 0 and write 1 → balance 1.
    expect((await db.collection("acct").findById("a")).balance).toBe(3);
  });
});
