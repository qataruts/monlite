import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Monlite } from "../src/index";
import { openDb } from "./helper";

let db: Monlite;
beforeEach(async () => {
  db = openDb();
  await db.collection("users").createMany({
    data: [
      { name: "Ali", role: "admin", age: 28, tags: ["a", "b"] },
      { name: "Sara", role: "editor", age: 24, tags: ["b", "c"] },
      { name: "Omar", role: "admin", age: 31, tags: ["c"] },
      { name: "Lina", role: "editor", age: 24 },
    ],
  });
});
afterEach(async () => {
  await db.$disconnect();
});

describe("distinct", () => {
  it("returns distinct scalar values", async () => {
    expect(await db.collection("users").distinct("role")).toEqual([
      "admin",
      "editor",
    ]);
    expect(await db.collection("users").distinct("age")).toEqual([24, 28, 31]);
  });

  it("unwinds array fields (each element is a value)", async () => {
    expect(await db.collection("users").distinct("tags")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("respects a where filter", async () => {
    expect(
      await db.collection("users").distinct("age", { role: "editor" }),
    ).toEqual([24]);
  });

  it("works on the _id system field", async () => {
    const ids = await db.collection("users").distinct("_id");
    expect(ids).toHaveLength(4);
  });
});
