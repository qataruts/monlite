import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { fts, type FtsSpec } from "../src/index";

const driver =
  (process.env.MONLITE_DRIVER as MonliteOptions["driver"]) || undefined;

const dbs: Monlite[] = [];
function open(spec: FtsSpec, file = ":memory:", withFts = true): Monlite {
  const d = createDb(file, {
    ...(withFts ? { plugins: [fts(spec)] } : {}),
    ...(driver ? { driver } : {}),
  });
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("@monlite/fts", () => {
  it("indexes on write and searches by rank", async () => {
    const db = open({ posts: ["title", "body"] });
    const posts = db.collection("posts");
    await posts.create({
      data: { _id: "1", title: "Hello world", body: "the quick brown fox" },
    });
    await posts.create({
      data: { _id: "2", title: "Goodbye", body: "lazy dog sleeps" },
    });

    const r = await posts.search("quick");
    expect(r.map((d) => d._id)).toEqual(["1"]);
    expect(typeof r[0]._score).toBe("number");
    expect(r[0].title).toBe("Hello world"); // full document returned
  });

  it("reflects updates and deletes", async () => {
    const db = open({ posts: ["body"] });
    const posts = db.collection("posts");
    await posts.create({ data: { _id: "1", body: "quick fox" } });
    await posts.create({ data: { _id: "2", body: "lazy dog" } });

    await posts.update({ where: { _id: "2" }, data: { body: "quick rabbit" } });
    expect((await posts.search("quick")).map((d) => d._id).sort()).toEqual([
      "1",
      "2",
    ]);

    await posts.delete({ where: { _id: "1" } });
    expect((await posts.search("quick")).map((d) => d._id)).toEqual(["2"]);
  });

  it("combines search with a where filter", async () => {
    const db = open({ posts: ["title"] });
    const posts = db.collection("posts");
    await posts.createMany({
      data: [
        { _id: "1", title: "quick start", status: "published" },
        { _id: "2", title: "quick notes", status: "draft" },
      ],
    });
    const r = await posts.search("quick", { where: { status: "draft" } });
    expect(r.map((d) => d._id)).toEqual(["2"]);
  });

  it("searches nested (dot-path) fields", async () => {
    const db = open({ users: ["name", "profile.bio"] });
    await db.collection("users").create({
      data: { _id: "u1", name: "Ali", profile: { bio: "loves astronomy" } },
    });
    const r = await db.collection("users").search("astronomy");
    expect(r.map((d) => d._id)).toEqual(["u1"]);
  });

  it("backfills existing documents when enabled on an existing db", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "monlite-fts-"));
    try {
      const file = join(tmp, "app.db");
      const a = open({}, file, false); // no FTS yet
      await a.collection("posts").create({
        data: { _id: "p1", title: "prewritten content" },
      });
      await a.$disconnect();
      dbs.pop(); // already disconnected

      const b = open({ posts: ["title"] }, file); // enabling FTS backfills
      const r = await b.collection("posts").search("prewritten");
      expect(r.map((d) => d._id)).toEqual(["p1"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
