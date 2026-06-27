import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Monlite } from "../src/index";
import { openDb } from "./helper";

let db: Monlite;
beforeEach(() => {
  db = openDb();
});
afterEach(async () => {
  await db.$disconnect();
});

describe("SQL escape hatch", () => {
  it("$queryRaw reads documents with json_extract", async () => {
    const users = db.collection("users");
    await users.createMany({
      data: [
        { name: "Ali", age: 28 },
        { name: "Sara", age: 17 },
      ],
    });
    const rows = await db.$queryRaw<{ name: string; age: number }>`
      SELECT json_extract(data, '$.name') AS name,
             json_extract(data, '$.age')  AS age
      FROM users
      WHERE json_extract(data, '$.age') >= ${18}
      ORDER BY age DESC
    `;
    expect(rows).toEqual([{ name: "Ali", age: 28 }]);
  });

  it("hybrid: SQL join across two collections written via the document API", async () => {
    const users = db.collection("users");
    const orders = db.collection("orders");
    const ali = await users.create({ data: { name: "Ali", role: "admin" } });
    await orders.create({ data: { userId: ali._id, amount: 500 } });
    await orders.create({ data: { userId: ali._id, amount: 250 } });

    const report = await db.$queryRaw<{ customer: string; revenue: number }>`
      SELECT json_extract(u.data, '$.name')         AS customer,
             SUM(json_extract(o.data, '$.amount'))  AS revenue
      FROM users u
      JOIN orders o ON json_extract(o.data, '$.userId') = u._id
      WHERE json_extract(u.data, '$.role') = 'admin'
      GROUP BY u._id
    `;
    expect(report).toEqual([{ customer: "Ali", revenue: 750 }]);
  });

  it("$executeRaw returns affected row count", async () => {
    const users = db.collection("users");
    await users.createMany({ data: [{ name: "A" }, { name: "B" }] });
    const changes = await db.$executeRaw`
      UPDATE users SET updated_at = ${Date.now()}
    `;
    expect(changes).toBe(2);
  });
});

describe("database management", () => {
  it("lists, drops collections", async () => {
    await db.collection("users").create({ data: { name: "x" } });
    await db.collection("orders").create({ data: { total: 1 } });
    expect(await db.$collections()).toEqual(["orders", "users"]);

    await db.$drop("orders");
    expect(await db.$collections()).toEqual(["users"]);

    await db.$dropAll();
    expect(await db.$collections()).toEqual([]);
  });

  it("$transaction rolls back on error", async () => {
    const users = db.collection("users");
    await users.create({ data: { name: "seed" } });
    await expect(
      db.$transaction(() => {
        db.sqlite
          .prepare(
            `INSERT INTO users(_id,data,created_at,updated_at) VALUES('z','{}',0,0)`,
          )
          .run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await users.count()).toBe(1);
  });

  it("rejects unsafe collection names", async () => {
    expect(() => db.collection('bad"name')).toThrow();
  });
});
