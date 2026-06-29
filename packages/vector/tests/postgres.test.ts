// @monlite/vector on the Postgres engine: a native generated vector(dim) column + HNSW index
// (pgvector), maintained by Postgres. Same collection.findSimilar() API as the sqlite-vec path.
// Skips cleanly without a reachable Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "@monlite/postgres";
import { vector } from "../src/index";

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

(available ? describe : describe.skip)(
  "@monlite/vector on Postgres (pgvector)",
  () => {
    let db: any;
    beforeAll(async () => {
      db = createDb(URL, {
        plugins: [
          vector({
            items: { field: "embedding", dimensions: 3, distance: "l2" },
          }),
        ],
      });
      await db.asyncDriver.exec(`DROP TABLE IF EXISTS items CASCADE`);
    });
    afterAll(async () => {
      if (db) await db.$disconnect();
    });

    it("finds nearest neighbours via a generated pgvector column", async () => {
      const items = db.collection("items");
      await items.createMany({
        data: [
          { _id: "a", embedding: [1, 0, 0], kind: "x" },
          { _id: "b", embedding: [0, 1, 0], kind: "y" },
          { _id: "c", embedding: [0.9, 0.1, 0], kind: "x" },
          { _id: "d", title: "no embedding here" }, // NULL vector → excluded
        ],
      });

      // ALTER ADD COLUMN GENERATED STORED backfills a/b/c on first findSimilar.
      const near = await items.findSimilar({ vector: [1, 0, 0], topK: 2 });
      expect(near.map((h: any) => h._id)).toEqual(["a", "c"]);
      expect(typeof near[0]._distance).toBe("number");
      expect(near[0]._distance).toBeCloseTo(0, 5); // exact match → distance 0

      // a normal monlite where-clause scopes the KNN (b is kind:y → excluded)
      const scoped = await items.findSimilar({
        vector: [1, 0, 0],
        topK: 5,
        where: { kind: "x" },
      });
      expect(scoped.map((h: any) => h._id)).toEqual(["a", "c"]);

      // dimension guard
      await expect(items.findSimilar({ vector: [1, 0] })).rejects.toThrow(
        /3-dimension/,
      );

      // a fresh write is immediately searchable (the column is auto-maintained)
      await items.create({ data: { _id: "e", embedding: [1, 0, 0.01], kind: "x" } });
      const near2 = await items.findSimilar({ vector: [1, 0, 0], topK: 3 });
      expect(near2.map((h: any) => h._id)).toContain("e");
    });
  },
);
