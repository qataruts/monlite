import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite } from "../src/index";

// Verifies the README's 10K–100K-document scale claim. Gated behind MONLITE_SCALE
// so normal CI stays fast; run with `MONLITE_SCALE=1 pnpm test scale`.
const scale = process.env.MONLITE_SCALE ? it : it.skip;

const dbs: Monlite[] = [];
const dir = mkdtempSync(join(tmpdir(), "monlite-scale-"));
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("scale (100K documents)", () => {
  scale(
    "ingests and queries 100K documents on a file database",
    async () => {
      const db = createDb(join(dir, "scale.db"), { wal: true });
      dbs.push(db);
      const c = db.collection("events", {
        schema: { kind: { type: "TEXT", index: true }, n: "INTEGER" },
      });

      const N = 100_000;
      const t0 = Date.now();
      // insert in batches to bound peak memory
      for (let b = 0; b < N; b += 10_000) {
        const data = Array.from({ length: 10_000 }, (_, i) => ({
          kind: (b + i) % 5 === 0 ? "special" : "normal",
          n: b + i,
        }));
        await c.createMany({ data });
      }
      const ingestMs = Date.now() - t0;

      expect(await c.count()).toBe(N);
      expect(await c.count({ where: { kind: "special" } })).toBe(N / 5);

      const t1 = Date.now();
      const rows = await c.findMany({
        where: { kind: "special", n: { lt: 1000 } },
      });
      const queryMs = Date.now() - t1;
      expect(rows.length).toBe(200);

      expect(db.checkIntegrity()).toBe(true);
      // eslint-disable-next-line no-console
      console.log(
        `100K ingest ${ingestMs}ms (${(ingestMs / N).toFixed(3)} ms/doc), indexed query ${queryMs}ms`,
      );
    },
    120_000,
  );
});
