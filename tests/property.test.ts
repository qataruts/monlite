import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite } from "../src/index";

/**
 * Property-based query testing: for many random datasets + filters, monlite's
 * result must equal an independent in-memory JS "oracle". Catches query-compiler
 * and operator edge cases that example-based tests miss. Seeded for reproducibility.
 */

// Small deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Doc = { _id: string; a?: number; b?: string; flag?: boolean };
const LETTERS = ["x", "y", "z"];

function genDocs(rand: () => number, n: number): Doc[] {
  const docs: Doc[] = [];
  for (let i = 0; i < n; i++) {
    const d: Doc = { _id: `d${i}` };
    if (rand() < 0.85) d.a = Math.floor(rand() * 10); // 0..9, sometimes absent
    if (rand() < 0.7) d.b = LETTERS[Math.floor(rand() * LETTERS.length)];
    if (rand() < 0.6) d.flag = rand() < 0.5;
    docs.push(d);
  }
  return docs;
}

type Filter = Record<string, any>;

function genFilter(rand: () => number): Filter {
  const pick = (): Filter => {
    const k = Math.floor(rand() * 7);
    const n = Math.floor(rand() * 10);
    switch (k) {
      case 0:
        return { a: n };
      case 1:
        return { a: { gte: n } };
      case 2:
        return { a: { lt: n } };
      case 3:
        return { a: { in: [n, (n + 3) % 10] } };
      case 4:
        return { a: { exists: rand() < 0.5 } };
      case 5:
        return { b: LETTERS[Math.floor(rand() * LETTERS.length)] };
      default:
        return { flag: rand() < 0.5 };
    }
  };
  const r = rand();
  if (r < 0.5) return pick();
  if (r < 0.75) return { AND: [pick(), pick()] };
  return { OR: [pick(), pick()] };
}

// The oracle — mirrors monlite's documented semantics for this operator subset.
function matchLeaf(doc: Doc, field: string, cond: any): boolean {
  const v = (doc as any)[field];
  if (cond !== null && typeof cond === "object") {
    if ("gte" in cond) return v !== undefined && v >= cond.gte;
    if ("lt" in cond) return v !== undefined && v < cond.lt;
    if ("in" in cond) return v !== undefined && cond.in.includes(v);
    if ("exists" in cond) return (v !== undefined) === cond.exists;
    return false;
  }
  return v === cond; // equals shorthand
}
function matchDoc(doc: Doc, filter: Filter): boolean {
  if ("AND" in filter)
    return (filter.AND as Filter[]).every((f) => matchDoc(doc, f));
  if ("OR" in filter)
    return (filter.OR as Filter[]).some((f) => matchDoc(doc, f));
  return Object.entries(filter).every(([k, cond]) => matchLeaf(doc, k, cond));
}

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("property-based query equivalence", () => {
  it("monlite findMany == in-memory oracle over random datasets/filters", async () => {
    for (let trial = 0; trial < 25; trial++) {
      const rand = rng(1000 + trial);
      const docs = genDocs(rand, 60);
      const db = openDb();
      dbs.push(db);
      const c = db.collection<Doc>("t");
      await c.createMany({ data: docs });

      for (let q = 0; q < 12; q++) {
        const filter = genFilter(rand);
        const got = (await c.findMany({ where: filter as any }))
          .map((d) => d._id)
          .sort();
        const want = docs
          .filter((d) => matchDoc(d, filter))
          .map((d) => d._id)
          .sort();
        expect(got, `trial ${trial} filter ${JSON.stringify(filter)}`).toEqual(
          want,
        );
      }
      await db.$disconnect();
      dbs.pop();
    }
  });
});
