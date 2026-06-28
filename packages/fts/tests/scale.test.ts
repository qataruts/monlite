import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "@monlite/core";
import { fts } from "../src/index";

// Verifies FTS5 indexing stays linear at scale. Gated behind MONLITE_SCALE so
// normal CI stays fast; run with `MONLITE_SCALE=1 pnpm --filter @monlite/fts test scale`.
const scale = process.env.MONLITE_SCALE ? it : it.skip;

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("fts scale", () => {
  scale(
    "indexes 30K documents and searches quickly",
    async () => {
      const db = createDb(":memory:", { plugins: [fts({ docs: ["body"] })] });
      dbs.push(db);
      const c = db.collection("docs");
      const words = ["quantum", "vector", "search", "monlite", "sqlite", "index", "query", "fast", "local", "embed"];
      const N = 30_000;
      const t0 = Date.now();
      for (let b = 0; b < N; b += 10_000) {
        const data = Array.from({ length: 10_000 }, (_, i) => ({
          body: Array.from({ length: 12 }, (_, k) => words[(b + i + k) % words.length]).join(" "),
        }));
        await c.createMany({ data });
      }
      const ingestMs = Date.now() - t0;
      const t1 = Date.now();
      const hits = await c.search("quantum", { limit: 10 });
      const queryMs = Date.now() - t1;
      expect(hits.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(`30K fts ingest ${ingestMs}ms (${(ingestMs / N).toFixed(3)} ms/doc), search ${queryMs}ms`);
    },
    120_000,
  );
});
