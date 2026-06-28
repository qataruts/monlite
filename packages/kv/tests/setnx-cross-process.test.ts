import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "setnx-worker.mjs");
const dist = join(here, "..", "dist", "index.js");
const dir = mkdtempSync(join(tmpdir(), "monlite-kv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The worker imports the built package, so this needs `pnpm build` first.
const run = existsSync(dist) ? it : it.skip;

function acquire(file: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("node", [worker, file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", () => resolve(out));
  });
}

describe("cross-process setNX (BEGIN IMMEDIATE)", () => {
  run(
    "exactly one of N racing processes wins the lock — no SQLITE_BUSY",
    async () => {
      const file = join(dir, "lock.db");
      const N = 12;
      const results = await Promise.all(
        Array.from({ length: N }, () => acquire(file)),
      );
      const won = results.filter((r) => r === "WON").length;
      const lost = results.filter((r) => r === "LOST").length;
      const errors = results.filter((r) => r.startsWith("ERR:"));
      expect(errors, errors.join(",")).toHaveLength(0);
      expect(won).toBe(1);
      expect(lost).toBe(N - 1);
    },
    30_000,
  );
});
