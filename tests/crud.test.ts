import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isObjectId, type Monlite } from "../src/index";
import { openDb } from "./helper";

interface User {
  name: string;
  age?: number;
  role?: string;
  active?: boolean;
  tags?: string[];
  address?: { city: string };
}

let db: Monlite;

beforeEach(() => {
  db = openDb();
});
afterEach(async () => {
  await db.$disconnect();
});

describe("create", () => {
  it("creates a document with system fields", async () => {
    const users = db.collection<User>("users");
    const u = await users.create({ data: { name: "Ali", age: 28 } });

    expect(u.name).toBe("Ali");
    expect(u.age).toBe(28);
    expect(isObjectId(u._id)).toBe(true);
    expect(typeof u.created_at).toBe("number");
    expect(u.created_at).toBe(u.updated_at);
  });

  it("honors a user-provided _id", async () => {
    const users = db.collection<User>("users");
    const u = await users.create({
      data: { _id: "custom-1", name: "Sara" } as any,
    });
    expect(u._id).toBe("custom-1");
    expect(await users.findById("custom-1")).toMatchObject({ name: "Sara" });
  });

  it("does not leak system fields into stored JSON", async () => {
    const users = db.collection<User>("users");
    const u = await users.create({ data: { name: "Ali" } });
    const raw = db.sqlite
      .prepare(`SELECT data FROM users WHERE _id = ?`)
      .get(u._id) as { data: string };
    const parsed = JSON.parse(raw.data);
    expect(parsed).toEqual({ name: "Ali" });
  });

  it("createMany inserts all docs in one transaction", async () => {
    const users = db.collection<User>("users");
    const res = await users.createMany({
      data: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    expect(res.count).toBe(3);
    expect(await users.count()).toBe(3);
  });
});

describe("read", () => {
  beforeEach(async () => {
    const users = db.collection<User>("users");
    await users.createMany({
      data: [
        { name: "Ali", age: 28, role: "admin" },
        { name: "Sara", age: 24, role: "editor" },
        { name: "Omar", age: 31, role: "admin" },
      ],
    });
  });

  it("findFirst returns first match or null", async () => {
    const users = db.collection<User>("users");
    expect(await users.findFirst({ where: { name: "Ali" } })).toMatchObject({
      age: 28,
    });
    expect(await users.findFirst({ where: { name: "Nobody" } })).toBeNull();
  });

  it("findMany supports orderBy, skip and take", async () => {
    const users = db.collection<User>("users");
    const res = await users.findMany({
      orderBy: { age: "desc" },
      take: 2,
    });
    expect(res.map((u) => u.name)).toEqual(["Omar", "Ali"]);

    const page2 = await users.findMany({ orderBy: { age: "asc" }, skip: 1 });
    expect(page2.map((u) => u.name)).toEqual(["Ali", "Omar"]);
  });

  it("select projects only chosen fields", async () => {
    const users = db.collection<User>("users");
    const res = await users.findMany({
      where: { name: "Ali" },
      select: { name: true },
    });
    expect(res[0]).toEqual({ name: "Ali" });
  });

  it("count respects where", async () => {
    const users = db.collection<User>("users");
    expect(await users.count()).toBe(3);
    expect(await users.count({ where: { role: "admin" } })).toBe(2);
  });
});

describe("update / upsert / delete", () => {
  it("update shallow-merges by default", async () => {
    const users = db.collection<User>("users");
    const u = await users.create({ data: { name: "Ali", age: 28 } });
    const updated = await users.update({
      where: { _id: u._id },
      data: { age: 29 },
    });
    expect(updated).toMatchObject({ name: "Ali", age: 29 });
    expect(updated!.updated_at).toBeGreaterThanOrEqual(u.created_at);
  });

  it("update returns null when nothing matches", async () => {
    const users = db.collection<User>("users");
    expect(
      await users.update({ where: { _id: "missing" }, data: { age: 1 } }),
    ).toBeNull();
  });

  it("updateMany returns a count", async () => {
    const users = db.collection<User>("users");
    await users.createMany({
      data: [
        { name: "A", role: "admin" },
        { name: "B", role: "admin" },
        { name: "C", role: "guest" },
      ],
    });
    const res = await users.updateMany({
      where: { role: "admin" },
      data: { active: true },
    });
    expect(res.count).toBe(2);
    expect(await users.count({ where: { active: true } })).toBe(2);
  });

  it("upsert creates then updates", async () => {
    const users = db.collection<User>("users");
    const created = await users.upsert({
      where: { name: "Ali" },
      create: { name: "Ali", age: 1 },
      update: { age: 2 },
    });
    expect(created.age).toBe(1);

    const updated = await users.upsert({
      where: { name: "Ali" },
      create: { name: "Ali", age: 1 },
      update: { age: 2 },
    });
    expect(updated.age).toBe(2);
    expect(await users.count({ where: { name: "Ali" } })).toBe(1);
  });

  it("delete and deleteMany", async () => {
    const users = db.collection<User>("users");
    await users.createMany({
      data: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    const deleted = await users.delete({ where: { name: "A" } });
    expect(deleted).toMatchObject({ name: "A" });
    expect(await users.count()).toBe(2);

    const res = await users.deleteMany();
    expect(res.count).toBe(2);
    expect(await users.count()).toBe(0);
  });
});

describe("write/update edge cases (swarm-found)", () => {
  it("upsert seeds where equality fields into the created doc (idempotent)", async () => {
    const db = openDb();
    const u = db.collection("u");
    await u.upsert({
      where: { email: "a@x.com" },
      create: { name: "Ali" },
      update: { $set: { seen: 1 } },
    });
    await u.upsert({
      where: { email: "a@x.com" },
      create: { name: "Ali" },
      update: { $set: { seen: 2 } },
    });
    expect(await u.count()).toBe(1);
    const d = await u.findFirst({});
    expect(d.email).toBe("a@x.com");
    expect(d.seen).toBe(2);
    await db.$disconnect();
  });
  it("numeric _id is matched by findById / where / in", async () => {
    const db = openDb();
    const c = db.collection("c");
    await c.create({ data: { _id: 123, v: "x" } });
    expect((await c.findById(123))?.v).toBe("x");
    expect((await c.findMany({ where: { _id: 123 } })).length).toBe(1);
    expect(
      (await c.findMany({ where: { _id: { in: [123, 456] } } })).length,
    ).toBe(1);
    await db.$disconnect();
  });
  it("$inc/$push/$addToSet on a non-conforming target and $set _id throw", async () => {
    const db = openDb();
    const c = db.collection("c");
    await c.create({ data: { _id: "a", n: "str", tags: "str" } });
    await expect(
      c.update({ where: { _id: "a" }, data: { $inc: { n: 1 } } }),
    ).rejects.toThrow();
    await expect(
      c.update({ where: { _id: "a" }, data: { $push: { tags: "y" } } }),
    ).rejects.toThrow();
    await expect(
      c.update({ where: { _id: "a" }, data: { $addToSet: { tags: "y" } } }),
    ).rejects.toThrow();
    await expect(
      c.update({ where: { _id: "a" }, data: { $set: { _id: "b" } } }),
    ).rejects.toThrow();
    await db.$disconnect();
  });
});
