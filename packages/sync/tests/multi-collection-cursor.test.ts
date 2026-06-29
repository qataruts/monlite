import { describe, it, expect } from "vitest";
import { PostgresAdapter, type PgQueryable } from "../src/adapters/postgres";

// A faithful in-memory fake of the tiny `pg` surface the adapter uses. It serves
// the pull SELECT (`WHERE _monlite_v > $1 ORDER BY _monlite_v ASC LIMIT $2`) from
// per-table arrays and no-ops everything else (ensure DDL etc.). This exercises
// the REAL adapter pull/cursor code — no Postgres required, so it runs in CI.
type Row = { _id: string; doc: any; v: string; deleted?: boolean };
function fakePool(data: Record<string, Row[]>): PgQueryable {
  return {
    async query(text: string, params: any[] = []) {
      // pull query: references _monlite_v and the cursor param $1 (now via COLLATE "C")
      if (!(/_monlite_v/.test(text) && />\s*\$1/.test(text)))
        return { rows: [] }; // ensure/DDL
      // table is schema-qualified: FROM "public"."posts" → capture the table.
      const table = text.match(/FROM\s+(?:"[^"]+"\.)?"([^"]+)"/)?.[1] ?? "";
      const since = String(params[0] ?? "");
      const limit = params[1] as number | undefined;
      let rows = (data[table] ?? [])
        .filter((r) => r.v > since)
        .sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
      if (limit && limit > 0) rows = rows.slice(0, limit);
      return {
        rows: rows.map((r) => ({
          _id: r._id,
          doc: r.doc ?? {},
          v: r.v,
          deleted: !!r.deleted,
        })),
      };
    },
  };
}

describe("multi-collection sync cursor (no data loss)", () => {
  it("paginates two collections with a small limit without skipping rows", async () => {
    // Collection A's versions run AHEAD of B's (string order "v2x" > "v1x").
    // A global cursor would advance to an A version and skip B's tail — the bug.
    const A: Row[] = Array.from({ length: 10 }, (_, i) => ({
      _id: `a${i}`,
      doc: { n: i },
      v: `v2${String(i).padStart(2, "0")}`,
    }));
    const B: Row[] = Array.from({ length: 5 }, (_, i) => ({
      _id: `b${i}`,
      doc: { n: i },
      v: `v1${String(i).padStart(2, "0")}`,
    }));
    const adapter = new PostgresAdapter({
      pool: fakePool({ posts: A, tags: B }),
    });

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await adapter.pull(cursor, {
        collections: ["posts", "tags"],
        limit: 4,
      });
      if (res.changes.length === 0) break;
      for (const c of res.changes) seen.add(`${c.collection}/${c._id}`);
      cursor = res.cursor;
    }

    // All 15 rows from BOTH collections must arrive exactly once.
    expect(seen.size).toBe(15);
    for (let i = 0; i < 10; i++) expect(seen.has(`posts/a${i}`)).toBe(true);
    for (let i = 0; i < 5; i++) expect(seen.has(`tags/b${i}`)).toBe(true);
  });
});
