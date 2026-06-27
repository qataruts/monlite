---
id: aggregation
title: Aggregation
---

# Aggregation

## groupBy

```ts
const byStatus = await orders.groupBy({
  by: ["status"],
  _count: true,
  _sum: { total: true },
  _avg: { total: true },
  where: { created_at: { gte: startOfMonth } },
  having: { _sum: { total: { gt: 1000 } } },
  orderBy: { _sum: { total: "desc" } },
});
// → [{ status: "paid", _count: 12, _sum: { total: 4200 }, _avg: { total: 350 } }, …]
```

Supported accumulators: `_count`, `_sum`, `_avg`, `_min`, `_max`.

## distinct

```ts
const cities = await users.distinct("address.city", { where: { active: true } });
// → ["Riyadh", "Doha", …]
```

## Raw SQL escape hatch

When you need something the query API doesn't express, drop to SQL:

```ts
const rows = db.raw.all(
  `SELECT json_extract(data, '$.city') AS city, count(*) AS n
   FROM users GROUP BY city ORDER BY n DESC`,
);
```

`db.sqlite` exposes the underlying driver handle for full control (used by the
companion packages).
