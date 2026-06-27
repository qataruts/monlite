import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "cas-worker.mjs");
const dist = join(here, "..", "dist", "index.js");
const dir = mkdtempSync(join(tmpdir(), "monlite-cas-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The worker imports the built core, so this needs `pnpm build` first.
const run = existsSync(dist) ? it : it.skip;

function claim(file: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("node", [worker, file, "j1"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", () => resolve(out));
  });
}

describe("cross-process CAS (findOneAndUpdate, BEGIN IMMEDIATE)", () => {
  run(
    "exactly one of N racing workers claims the job — no BUSY errors",
    async () => {
      const file = join(dir, "jobs.db");
      const seed = createDb(file, { synchronous: "FULL" });
      await seed
        .collection("jobs")
        .create({ data: { _id: "j1", status: "pending", version: 0 } });
      await seed.$disconnect();

      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => claim(file)),
      );

      const won = results.filter((r) => r === "WON").length;
      const lost = results.filter((r) => r === "LOST").length;
      const errored = results.filter((r) => r.startsWith("ERR"));

      expect(errored).toEqual([]); // no SQLITE_BUSY_SNAPSHOT — clean CAS
      expect(won).toBe(1); // claimed exactly once
      expect(lost).toBe(N - 1); // everyone else cleanly lost

      const db = createDb(file);
      const job = (await db.collection("jobs").findById("j1"))!;
      expect(job.status).toBe("active");
      expect(job.version).toBe(1); // bumped exactly once, no double-claim
      await db.$disconnect();
    },
    20_000,
  );
});
