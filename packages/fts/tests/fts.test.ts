import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Monlite, type MonliteOptions } from "@monlite/core";
import { fts, createSearchIndex, type FtsSpec } from "../src/index";

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
      // Windows can't unlink an open file — close handles before removing.
      while (dbs.length) await dbs.pop()!.$disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("catchUp() picks up cross-process writes and deletes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "monlite-fts-"));
    try {
      const file = join(tmp, "app.db");
      const reader = open({ posts: ["title"] }, file); // has FTS
      const writer = open({}, file, false); // separate connection, no FTS plugin

      // the writer adds a doc — the reader's in-process index doesn't know about it
      await writer.collection("posts").create({
        data: { _id: "p1", title: "hello world" },
      });
      expect((await reader.collection("posts").search("hello")).length).toBe(0);

      // catch up → now searchable
      const res = reader.collection("posts").catchUp();
      expect(res.indexed).toBeGreaterThan(0);
      expect(
        (await reader.collection("posts").search("hello")).map((d) => d._id),
      ).toEqual(["p1"]);

      // a cross-process delete is also reconciled
      await writer.collection("posts").delete({ where: { _id: "p1" } });
      const res2 = reader.collection("posts").catchUp();
      expect(res2.removed).toBe(1);
      expect((await reader.collection("posts").search("hello")).length).toBe(0);
    } finally {
      // Windows can't unlink an open file — close handles before removing.
      while (dbs.length) await dbs.pop()!.$disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("createSearchIndex (dynamic, programmatic)", () => {
  function idxDb(): Monlite {
    const d = createDb(":memory:", { ...(driver ? { driver } : {}) });
    dbs.push(d);
    return d;
  }

  it("indexes fields and searches by relevance", () => {
    const idx = createSearchIndex(idxDb());
    idx.ensureCollection("docs", {
      fields: ["title", "body"],
      filterFields: ["docId"],
    });
    idx.upsert("docs", [
      {
        id: "c1",
        fields: { title: "hello world", body: "the quick brown fox" },
        filters: { docId: "d1" },
      },
      {
        id: "c2",
        fields: { title: "goodbye", body: "lazy dog sleeps" },
        filters: { docId: "d2" },
      },
    ]);
    const hits = idx.search("docs", "quick fox");
    expect(hits.map((h) => h.id)).toEqual(["c1"]);
    expect(hits[0].score).toBeGreaterThan(-100);
  });

  it("scopes the MATCH with a where (per-case/per-tenant)", () => {
    const idx = createSearchIndex(idxDb());
    idx.ensureCollection("docs", { fields: ["body"], filterFields: ["docId"] });
    idx.upsert("docs", [
      {
        id: "a",
        fields: { body: "contract terms and conditions" },
        filters: { docId: "d1" },
      },
      {
        id: "b",
        fields: { body: "contract pricing schedule" },
        filters: { docId: "d2" },
      },
    ]);
    const all = idx.search("docs", "contract");
    expect(all.length).toBe(2);
    const scoped = idx.search("docs", "contract", { where: { docId: "d1" } });
    expect(scoped.map((h) => h.id)).toEqual(["a"]);
  });

  it("upsert is idempotent; delete by id and where", () => {
    const idx = createSearchIndex(idxDb());
    idx.ensureCollection("docs", { fields: ["body"], filterFields: ["docId"] });
    idx.upsert("docs", [
      { id: "a", fields: { body: "alpha" }, filters: { docId: "d1" } },
    ]);
    idx.upsert("docs", [
      { id: "a", fields: { body: "beta" }, filters: { docId: "d1" } },
    ]);
    expect(idx.search("docs", "alpha").length).toBe(0);
    expect(idx.search("docs", "beta").map((h) => h.id)).toEqual(["a"]);
    idx.upsert("docs", [
      { id: "b", fields: { body: "beta" }, filters: { docId: "d2" } },
    ]);
    idx.delete("docs", { id: "a" });
    expect(idx.search("docs", "beta").map((h) => h.id)).toEqual(["b"]);
    idx.delete("docs", { where: { docId: "d2" } });
    expect(idx.search("docs", "beta").length).toBe(0);
  });
});

describe("where recall (over-fetch then filter)", () => {
  it("returns a filtered match that ranks outside the limit", async () => {
    const c = open({ docs: ["body"] }).collection("docs");
    const data: any[] = [];
    for (let i = 0; i < 60; i++)
      data.push({
        body: i === 59 ? "apple" : "apple apple apple apple",
        flag: i === 59,
      });
    await c.createMany({ data });
    // The only flag=true doc ranks last; with limit 3 it must still be found.
    const hits = await c.search("apple", { where: { flag: true }, limit: 3 });
    expect(hits).toHaveLength(1);
    expect((hits[0] as any).flag).toBe(true);
  });
});

describe("search tolerates malformed FTS5 input", () => {
  it("never throws on untrusted query syntax", async () => {
    const c = open({ docs: ["body"] }).collection("docs");
    await c.createMany({ data: [{ body: "the quick brown fox" }] });
    for (const q of ["quick", 'a "b', '"', "AND", "fox*", "x:y", "a OR", "("]) {
      await expect(c.search(q)).resolves.toBeDefined();
    }
    // a normal term still matches
    expect((await c.search("quick")).length).toBe(1);
  });
});

describe("search caps the where candidate pool", () => {
  it("a huge candidates value + where does not overflow SQL variables", async () => {
    const c = open({ d: ["body"] }).collection("d");
    await c.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        body: "apple " + i,
        live: i % 2 === 0,
      })),
    });
    await expect(
      c.search("apple", {
        where: { live: true },
        limit: 5,
        candidates: 50_000,
      }),
    ).resolves.toBeDefined();
  });
});
