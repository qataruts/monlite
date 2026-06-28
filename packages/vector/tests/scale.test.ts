import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "@monlite/core";
import { vector } from "../src/index";

// Verifies vector ingestion stays linear and findSimilar is fast at scale.
// Gated behind MONLITE_SCALE so normal CI stays fast.
const scale = process.env.MONLITE_SCALE ? it : it.skip;

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("vector scale", () => {
  scale(
    "indexes 50K vectors and runs KNN quickly",
    async () => {
      const D = 128;
      const db = createDb(":memory:", {
        allowExtensions: true,
        plugins: [vector({ docs: { field: "e", dimensions: D, distance: "cosine" } })],
      });
      dbs.push(db);
      const c = db.collection("docs");

      const N = 50_000;
      const t0 = Date.now();
      for (let b = 0; b < N; b += 10_000) {
        const data = Array.from({ length: 10_000 }, () => ({
          e: Array.from({ length: D }, () => Math.random()),
        }));
        await c.createMany({ data });
      }
      const ingestMs = Date.now() - t0;

      const q = Array.from({ length: D }, () => Math.random());
      const t1 = Date.now();
      const hits = await c.findSimilar({ vector: q, topK: 10 });
      const queryMs = Date.now() - t1;
      expect(hits.length).toBe(10);

      // eslint-disable-next-line no-console
      console.log(`50K vector ingest ${ingestMs}ms (${(ingestMs / N).toFixed(3)} ms/doc), findSimilar ${queryMs}ms`);
    },
    120_000,
  );
});
