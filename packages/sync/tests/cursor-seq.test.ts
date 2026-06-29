import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@monlite/core";
import { decodeCursor } from "../src/cursor";

describe("cursor decode hardening", () => {
  it("corrupt {-leading cursor → empty (not a high floor that stalls sync)", () => {
    expect(decodeCursor('{"a":"1"').perColl).toEqual({}); // truncated JSON
    expect(decodeCursor('{"a":"1"').legacy).toBe(""); // NOT a scalar floor
    expect(decodeCursor("v123").legacy).toBe("v123"); // genuine legacy still works
    expect(decodeCursor('{"a":"v1"}').perColl).toEqual({ a: "v1" });
  });
});

describe("versionSeq resumes by insertion order (clock-jump safe)", () => {
  it("resumes past the last-minted seq even if its timestamp is lower", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monlite-seq-"));
    const file = join(dir, "seq.db");
    let db = createDb(file, { sync: true });
    await db.collection("t").create({ data: { n: 0 } });
    // a later write with a LOWER ts but HIGHER seq (backward clock jump)
    db.sqlite
      .prepare(
        "INSERT INTO _monlite_changes (coll, doc_id, op, version, ts, source, pushed) VALUES ('t','z','upsert','0000000001:node:000009',1,'local',0)",
      )
      .run();
    await db.$disconnect();
    db = createDb(file, { sync: true });
    await db.collection("t").create({ data: { n: 1 } });
    const v: any = db.sqlite
      .prepare(
        "SELECT version FROM _monlite_changes WHERE doc_id NOT IN ('z') ORDER BY seq DESC LIMIT 1",
      )
      .get();
    const seq = parseInt(v.version.slice(v.version.lastIndexOf(":") + 1), 10);
    expect(seq).toBeGreaterThanOrEqual(10);
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });
});
