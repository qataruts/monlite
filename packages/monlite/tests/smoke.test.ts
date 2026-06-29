import { describe, it, expect } from "vitest";
import {
  createDb,
  kv,
  createQueue,
  createCron,
  parseCron,
  nextCronRun,
  fts,
  vector,
  sync,
  realtime,
} from "../src/index";
import { kv as kvSubpath } from "../src/kv";
import { vector as vectorSubpath } from "../src/vector";
import { connectRealtime } from "../src/realtime-client";
import { kv as kvStandalone } from "@monlite/kv";
import { vector as vectorStandalone } from "@monlite/vector";
import type { MonliteOptions } from "@monlite/core";

const driver = (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;
const open = () => createDb(":memory:", driver ? { driver } : {});

describe("monlite (barrel)", () => {
  it("re-exports the SAME objects as the standalone packages (thin re-export)", () => {
    expect(kv).toBe(kvStandalone);
    expect(vector).toBe(vectorStandalone);
    // Top-level and subpath resolve to the one module.
    expect(kvSubpath).toBe(kvStandalone);
    expect(vectorSubpath).toBe(vectorStandalone);
  });

  it("exposes every bundled factory at the top level", () => {
    for (const fn of [
      createDb,
      createQueue,
      createCron,
      fts,
      vector,
      sync,
      realtime,
      connectRealtime,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(typeof kv).toBe("function");
  });

  it("cron helpers work through the barrel", () => {
    expect(parseCron("0 9 * * *").hour.has(9)).toBe(true);
    expect(
      nextCronRun("0 9 * * *", new Date("2026-01-01T00:00:00Z")) instanceof Date,
    ).toBe(true);
  });

  it("core + kv + queue compose through the barrel", async () => {
    const db = open();
    const notes = db.collection<{ title: string }>("notes");
    await notes.create({ data: { _id: "a", title: "hello" } });
    expect((await notes.findMany()).length).toBe(1);

    const cache = kv(db);
    cache.set("greeting", { n: 1 });
    expect(cache.get("greeting")).toEqual({ n: 1 });

    const q = createQueue(db);
    const job = q.add("send-email", { to: "x@example.com" });
    expect(job.queue).toBe("send-email");
    expect(typeof job.id).toBe("number");

    await db.$disconnect();
  });
});
