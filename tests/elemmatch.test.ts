import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite } from "../src/index";

const dbs: Monlite[] = [];
function db(): Monlite {
  const d = openDb();
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("elemMatch (array element predicates)", () => {
  it("matches array-of-objects elements against a sub-filter (same element)", async () => {
    const c = db().collection("orders");
    await c.createMany({
      data: [
        {
          _id: "o1",
          items: [
            { sku: "A", qty: 2 },
            { sku: "B", qty: 5 },
          ],
        },
        { _id: "o2", items: [{ sku: "A", qty: 1 }] }, // A but qty < 2
        { _id: "o3", items: [{ sku: "C", qty: 9 }] }, // qty ok but not A
      ],
    });

    const r = await c.findMany({
      where: { items: { elemMatch: { sku: "A", qty: { gte: 2 } } } },
      orderBy: { _id: "asc" },
    });
    expect(r.map((d) => d._id)).toEqual(["o1"]);
  });

  it("matches arrays of scalars", async () => {
    const c = db().collection("students");
    await c.createMany({
      data: [
        { _id: "s1", scores: [70, 95] },
        { _id: "s2", scores: [60, 80] },
      ],
    });
    const r = await c.findMany({
      where: { scores: { elemMatch: { gte: 90 } } },
    });
    expect(r.map((d) => d._id)).toEqual(["s1"]);
  });

  it("composes with other conditions", async () => {
    const c = db().collection("orders");
    await c.createMany({
      data: [
        { _id: "o1", region: "eu", items: [{ sku: "A", qty: 5 }] },
        { _id: "o2", region: "us", items: [{ sku: "A", qty: 5 }] },
      ],
    });
    const r = await c.findMany({
      where: { region: "eu", items: { elemMatch: { qty: { gte: 3 } } } },
    });
    expect(r.map((d) => d._id)).toEqual(["o1"]);
  });
});
