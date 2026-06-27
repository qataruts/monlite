import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "crash-worker.mjs");
const dist = join(here, "..", "dist", "index.js");
const dir = mkdtempSync(join(tmpdir(), "monlite-crash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The worker imports the built core, so this needs `pnpm build` first.
const run = existsSync(dist) ? it : it.skip;

describe("crash consistency", () => {
  run(
    "survives SIGKILL mid-transaction — integrity intact, no torn write",
    async () => {
      const file = join(dir, "bank.db");
      const seed = createDb(file, { synchronous: "FULL" });
      await seed.collection("acct").createMany({
        data: [
          { _id: "A", bal: 100_000 },
          { _id: "B", bal: 0 },
        ],
      });
      await seed.$disconnect();

      // a separate process hammers atomic A→B transfers…
      const child = spawn("node", [worker, file], { stdio: "ignore" });
      // …wait until it has actually committed progress (so the test is meaningful
      // and not timing-flaky under load), then kill it abruptly, mid-flight.
      const probe = createDb(file);
      let moved = 0;
      for (let i = 0; i < 400 && moved < 100; i++) {
        await sleep(25);
        moved = (await probe.collection("acct").findById("B"))?.bal ?? 0;
      }
      await probe.$disconnect();
      expect(moved).toBeGreaterThanOrEqual(100); // worker made real progress
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
      await sleep(100);

      // reopen and verify the database is sound
      const db = createDb(file);
      expect(db.checkIntegrity()).toBe(true); // no corruption
      const a = (await db.collection("acct").findById("A"))!;
      const b = (await db.collection("acct").findById("B"))!;
      // every committed transfer conserved the total; a torn transaction would not
      expect(a.bal + b.bal).toBe(100_000);
      // and it actually did work (the test is meaningful)
      expect(b.bal).toBeGreaterThan(0);
      await db.$disconnect();
    },
    20_000,
  );
});
