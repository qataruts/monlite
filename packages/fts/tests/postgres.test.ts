// @monlite/fts on the Postgres engine: a native generated tsvector column + GIN index,
// maintained by Postgres. Same collection.search() API as the SQLite (FTS5) path.
// Skips cleanly without a reachable Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, postgres } from "@monlite/postgres";
import { fts } from "../src/index";

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

let available = false;
try {
  const d = postgres(URL);
  await d.query("SELECT 1");
  await d.close();
  available = true;
} catch {
  available = false;
}

(available ? describe : describe.skip)("@monlite/fts on Postgres (tsvector)", () => {
  let db: any;
  beforeAll(async () => {
    db = createDb(URL, { plugins: [fts({ docs: ["title", "body"] })] });
    await db.asyncDriver.exec(`DROP TABLE IF EXISTS docs CASCADE`);
  });
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it("ranks matches via a generated tsvector column (search() works on PG)", async () => {
    const docs = db.collection("docs");
    await docs.createMany({
      data: [
        { _id: "1", title: "Postgres full text", body: "tsvector and gin indexes" },
        { _id: "2", title: "SQLite FTS5", body: "the bm25 ranking function" },
        { _id: "3", title: "Hello world", body: "nothing relevant here" },
      ],
    });

    // ALTER ADD COLUMN GENERATED STORED backfills the existing rows on first search.
    const hits = await docs.search("postgres tsvector");
    expect(hits[0]._id).toBe("1");
    expect(typeof hits[0]._score).toBe("number");

    // websearch_to_tsquery negation: "-bm25" excludes doc 2
    const neg = await docs.search("ranking -bm25");
    expect(neg.find((h: any) => h._id === "2")).toBeUndefined();

    // a normal monlite where-clause scopes the match
    const scoped = await docs.search("indexes", { where: { _id: { in: ["1"] } } });
    expect(scoped.map((h: any) => h._id)).toEqual(["1"]);

    // newly written docs are searchable immediately (the column is auto-maintained)
    await docs.create({ data: { _id: "4", title: "More tsvector goodness", body: "x" } });
    const fresh = await docs.search("tsvector");
    expect(fresh.map((h: any) => h._id).sort()).toEqual(["1", "4"]);
  });
});
