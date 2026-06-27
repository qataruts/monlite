import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createDb, type Monlite } from "@monlite/core";
import { createStudioServer } from "../src/index";

let db: Monlite;
let server: Server;
let base: string;

const get = async (p: string) => {
  const r = await fetch(base + p);
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  db = createDb(":memory:");
  await db.collection("users").createMany({
    data: [
      { _id: "u1", name: "Ali", age: 30 },
      { _id: "u2", name: "Sara", age: 20 },
    ],
  });
  await db.collection("orders", { schema: { total: "REAL" } }).create({
    data: { _id: "o1", total: 99 },
  });

  server = createStudioServer(":memory:", { db });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.$disconnect();
});

describe("@monlite/studio", () => {
  it("serves the UI page", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("monlite studio");
  });

  it("lists collections with counts (excludes system/non-collection tables)", async () => {
    const { body } = await get("/api/meta");
    const names = body.collections.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["users", "orders"]));
    expect(body.collections.find((c: any) => c.name === "users").count).toBe(2);
  });

  it("browses documents with a where filter", async () => {
    const where = encodeURIComponent(JSON.stringify({ age: { gte: 25 } }));
    const { body } = await get(`/api/docs?collection=users&where=${where}`);
    expect(body.total).toBe(1);
    expect(body.results[0].name).toBe("Ali");
  });

  it("404s an unknown collection without creating a table", async () => {
    const { status } = await get("/api/docs?collection=ghost");
    expect(status).toBe(404);
    const { body } = await get("/api/meta");
    expect(body.collections.map((c: any) => c.name)).not.toContain("ghost");
  });

  it("deletes a document", async () => {
    const del = await fetch(`${base}/api/docs?collection=users&id=u2`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const { body } = await get("/api/docs?collection=users");
    expect(body.total).toBe(1);
  });
});
