import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import { MonliteUniqueConstraintError, type Monlite } from "../src/index";

const dbs: Monlite[] = [];
function db(): Monlite {
  const d = openDb();
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("AI-harness core primitives", () => {
  it("enforces compound unique indexes", async () => {
    const c = db().collection("steps", {
      uniqueIndexes: [["tenantId", "jobId", "key"]],
    });
    await c.create({ data: { tenantId: "t1", jobId: "j1", key: "a" } });
    await c.create({ data: { tenantId: "t1", jobId: "j1", key: "b" } }); // diff key — ok
    await c.create({ data: { tenantId: "t1", jobId: "j2", key: "a" } }); // diff job — ok

    await expect(
      c.create({ data: { tenantId: "t1", jobId: "j1", key: "a" } }), // duplicate
    ).rejects.toBeInstanceOf(MonliteUniqueConstraintError);
  });

  it("findOneAndUpdate does atomic CAS — match version+status, return new or null", async () => {
    const jobs = db().collection("jobs");
    await jobs.create({ data: { _id: "j1", status: "pending", version: 0 } });

    // claim: compare-and-swap on version 0 + status pending
    const claimed = await jobs.findOneAndUpdate({
      where: { _id: "j1", version: 0, status: { in: ["pending"] } },
      data: { $set: { status: "running" }, $inc: { version: 1 } },
    });
    expect(claimed?.version).toBe(1);
    expect(claimed?.status).toBe("running");

    // a stale CAS (still expecting version 0) loses → null, no change
    const lost = await jobs.findOneAndUpdate({
      where: { _id: "j1", version: 0, status: { in: ["pending"] } },
      data: { $set: { status: "done" }, $inc: { version: 1 } },
    });
    expect(lost).toBeNull();
    expect((await jobs.findById("j1"))!.version).toBe(1); // untouched
  });

  it("purgeExpired removes documents past their TTL", async () => {
    const d = db();
    const c = d.collection("events", {
      ttl: { field: "created_at", seconds: 1 },
    });
    await c.create({ data: { _id: "old" } });
    await c.create({ data: { _id: "fresh" } });
    // age the "old" row beyond the TTL
    d.driver
      .prepare(`UPDATE "events" SET created_at = ? WHERE _id = ?`)
      .run(Date.now() - 5000, "old");

    const { count } = await c.purgeExpired();
    expect(count).toBe(1);
    expect(await c.findById("old")).toBeNull();
    expect(await c.findById("fresh")).not.toBeNull();
  });
});
