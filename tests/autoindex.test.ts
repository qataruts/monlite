import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "../src/index";

let db: Monlite;
afterEach(async () => {
  await db?.$disconnect();
});

function indexNames(d: Monlite): string[] {
  return (
    d.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("auto-indexing", () => {
  it("creates an index after the threshold is crossed", async () => {
    db = createDb(":memory:", { autoIndexAfter: 3 });
    const users = db.collection("users");
    await users.create({ data: { city: "Riyadh" } });

    for (let i = 0; i < 2; i++) {
      await users.findMany({ where: { city: "Riyadh" } });
    }
    expect(indexNames(db).some((n) => n.includes("city"))).toBe(false);

    await users.findMany({ where: { city: "Riyadh" } }); // crosses threshold
    expect(indexNames(db).some((n) => n.includes("city"))).toBe(true);
  });

  it("can be disabled", async () => {
    db = createDb(":memory:", { autoIndex: false, autoIndexAfter: 1 });
    const users = db.collection("users");
    await users.create({ data: { city: "Riyadh" } });
    await users.findMany({ where: { city: "Riyadh" } });
    await users.findMany({ where: { city: "Riyadh" } });
    expect(indexNames(db).some((n) => n.includes("city"))).toBe(false);
  });
});
