// Joins across collections with $lookup / $unwind. Run: node joins.mjs
import { createDb } from "@monlite/core";

const db = createDb(":memory:");

await db.collection("users").createMany({
  data: [
    { _id: "u1", name: "Ali" },
    { _id: "u2", name: "Sara" },
  ],
});
await db.collection("orders").createMany({
  data: [
    { _id: "o1", user_id: "u1", total: 100 },
    { _id: "o2", user_id: "u1", total: 40 },
    { _id: "o3", user_id: "u2", total: 25 },
  ],
});

// $lookup — attach each user's orders as an array.
const withOrders = await db.collection("users").findMany({
  orderBy: { _id: "asc" },
  lookup: {
    from: "orders",
    localField: "_id",
    foreignField: "user_id",
    as: "orders",
  },
});
for (const u of withOrders) {
  console.log(
    `🧑 ${u.name}:`,
    u.orders.map((o) => o.total),
  );
}

// $unwind — one row per order, each joined to its user.
const flat = await db.collection("orders").findMany({
  orderBy: { _id: "asc" },
  lookup: {
    from: "users",
    localField: "user_id",
    foreignField: "_id",
    as: "user",
    unwind: true,
  },
});
for (const o of flat) {
  console.log(`🧾 order ${o._id} → ${o.user.name} ($${o.total})`);
}

await db.$disconnect();
