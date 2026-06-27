import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { vector, type VectorSpec } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;

const dbs: Monlite[] = [];
function open(spec: VectorSpec): Monlite {
  const d = createDb(":memory:", {
    allowExtensions: true,
    plugins: [vector(spec)],
    ...(driver ? { driver } : {}),
  });
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

const spec: VectorSpec = { docs: { field: "embedding", dimensions: 3 } };

describe("@monlite/vector", () => {
  it("ranks nearest neighbours by distance", async () => {
    const docs = open(spec).collection("docs");
    await docs.createMany({
      data: [
        { _id: "x", embedding: [1, 0, 0] },
        { _id: "y", embedding: [0, 1, 0] },
        { _id: "z", embedding: [0, 0, 1] },
      ],
    });
    const r = await docs.findSimilar({ vector: [0.9, 0.1, 0], topK: 2 });
    expect(r.map((d) => d._id)).toEqual(["x", "y"]);
    expect(r[0]._distance).toBeLessThan(r[1]._distance);
    expect(r).toHaveLength(2); // topK respected
  });

  it("reflects updates and deletes", async () => {
    const docs = open(spec).collection("docs");
    await docs.create({ data: { _id: "a", embedding: [1, 0, 0] } });
    await docs.create({ data: { _id: "b", embedding: [0, 0, 1] } });

    // Move b near the query, then it should rank ahead of nothing-changed a.
    await docs.update({ where: { _id: "b" }, data: { embedding: [0, 1, 0] } });
    const near = await docs.findSimilar({ vector: [0, 1, 0], topK: 1 });
    expect(near[0]._id).toBe("b");

    await docs.delete({ where: { _id: "a" } });
    const all = await docs.findSimilar({ vector: [1, 0, 0], topK: 5 });
    expect(all.map((d) => d._id)).not.toContain("a");
  });

  it("ignores documents without an embedding", async () => {
    const docs = open(spec).collection("docs");
    await docs.create({ data: { _id: "with", embedding: [1, 0, 0] } });
    await docs.create({ data: { _id: "without", label: "no vector" } });
    const r = await docs.findSimilar({ vector: [1, 0, 0], topK: 10 });
    expect(r.map((d) => d._id)).toEqual(["with"]);
  });

  it("combines similarity with a where filter", async () => {
    const docs = open(spec).collection("docs");
    await docs.createMany({
      data: [
        { _id: "p", embedding: [1, 0, 0], status: "published" },
        { _id: "d", embedding: [1, 0, 0], status: "draft" },
      ],
    });
    const r = await docs.findSimilar({
      vector: [1, 0, 0],
      topK: 5,
      where: { status: "draft" },
    });
    expect(r.map((d) => d._id)).toEqual(["d"]);
  });

  it("supports the cosine metric", async () => {
    const docs = open({
      docs: { field: "embedding", dimensions: 3, distance: "cosine" },
    }).collection("docs");
    await docs.create({ data: { _id: "a", embedding: [2, 0, 0] } }); // same direction as query
    await docs.create({ data: { _id: "b", embedding: [0, 5, 0] } });
    const r = await docs.findSimilar({ vector: [1, 0, 0], topK: 1 });
    expect(r[0]._id).toBe("a"); // cosine: direction matters, not magnitude
  });

  it("validates the query vector dimension", async () => {
    const docs = open(spec).collection("docs");
    await expect(
      docs.findSimilar({ vector: [1, 0], topK: 1 }),
    ).rejects.toThrow();
  });
});
