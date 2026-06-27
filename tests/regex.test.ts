import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite } from "../src/index";

const dbs: Monlite[] = [];
function db(): Monlite {
  const d = openDb();
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("regex operator", () => {
  it("matches by pattern string (anchored)", async () => {
    const c = db().collection("users");
    await c.createMany({
      data: [
        { _id: "u1", email: "ali@acme.com" },
        { _id: "u2", email: "sara@other.org" },
        { _id: "u3", email: "joe@acme.com.evil.net" },
      ],
    });
    const r = await c.findMany({
      where: { email: { regex: "@acme\\.com$" } },
      orderBy: { _id: "asc" },
    });
    expect(r.map((d) => d._id)).toEqual(["u1"]);
  });

  it("supports case-insensitive mode", async () => {
    const c = db().collection("users");
    await c.create({ data: { _id: "u1", name: "Alice" } });
    const r = await c.findMany({
      where: { name: { regex: "^alice$", mode: "insensitive" } },
    });
    expect(r.map((d) => d._id)).toEqual(["u1"]);
  });

  it("accepts a RegExp instance and honours its flags", async () => {
    const c = db().collection("users");
    await c.create({ data: { _id: "u1", name: "Bob" } });
    const r = await c.findMany({ where: { name: { regex: /^bob$/i } } });
    expect(r.map((d) => d._id)).toEqual(["u1"]);
  });

  it("composes with other conditions and nested paths", async () => {
    const c = db().collection("users");
    await c.createMany({
      data: [
        { _id: "u1", role: "admin", profile: { handle: "ace_01" } },
        { _id: "u2", role: "admin", profile: { handle: "ZZZ" } },
        { _id: "u3", role: "guest", profile: { handle: "bee_02" } },
      ],
    });
    const r = await c.findMany({
      where: {
        role: "admin",
        "profile.handle": { regex: "^[a-z]+_\\d+$" },
      },
    });
    expect(r.map((d) => d._id)).toEqual(["u1"]);
  });

  it("returns nothing when no document matches", async () => {
    const c = db().collection("users");
    await c.create({ data: { _id: "u1", name: "Alice" } });
    const r = await c.findMany({ where: { name: { regex: "^zzz" } } });
    expect(r).toHaveLength(0);
  });
});
