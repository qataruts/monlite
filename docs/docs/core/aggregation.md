---
id: aggregation
title: Aggregation
---

# Aggregation

monlite ships three aggregation primitives: `aggregate` (whole-collection rollups),
`groupBy` (`GROUP BY` with accumulators, `HAVING`, and top-N), and `distinct` (unique
values). All three accept the same `where` filter as ordinary queries, and **all three
run identically on the [Postgres engine](/packages/postgres)** — the same calls compile
to JSONB aggregation SQL there.

## `aggregate` — whole-collection rollups

Compute counts and numeric rollups over the documents that match `where`. The available
accumulators are `_count`, `_sum`, `_avg`, `_min`, and `_max`. `_sum`/`_avg`/`_min`/`_max`
take a `{ field: true }` selection of which fields to roll up.

```ts
const stats = await orders.aggregate({
  where: { status: "shipped" },
  _count: true,
  _sum: { total: true, quantity: true },
  _avg: { total: true },
  _min: { total: true },
  _max: { total: true },
});
```

Result shape — one bucket per accumulator, keyed by field:

```ts
{
  _count: 128,
  _sum: { total: 53120.5, quantity: 412 },
  _avg: { total: 415.0 },
  _min: { total: 9.99 },
  _max: { total: 1999.0 },
}
```

Each accumulator key is present only if you requested it. `_count` is a number; the
others are `Record<field, number | null>` (a field with no numeric values yields `null`).

```ts
// minimal — just a filtered count
const open = await orders.aggregate({ where: { status: "open" }, _count: true });
open._count; // number
```

## `groupBy` — GROUP BY with accumulators

Group by one or more fields and compute accumulators per group. `by` is a non-empty
array of field names (or dot-paths); `where` filters rows **before** grouping; `having`
filters groups **after**; `orderBy` sorts the groups; `take`/`skip` page them.

```ts
const byCustomer = await orders.groupBy({
  by: ["customerId"],
  where: { status: "shipped" },
  _count: true,
  _sum: { total: true },
  _avg: { total: true },
  having: { _sum: { total: { gt: 1000 } } }, // only big spenders
  orderBy: { _sum: { total: "desc" } },       // sort by an accumulator
  take: 10,                                    // top 10
});
```

Each result row has the grouped fields plus the requested accumulators:

```ts
[
  { customerId: "c-42", _count: 9, _sum: { total: 5210.0 }, _avg: { total: 578.9 } },
  { customerId: "c-7",  _count: 4, _sum: { total: 3120.0 }, _avg: { total: 780.0 } },
  // …
]
```

### Multiple group keys

```ts
await sales.groupBy({
  by: ["region", "category"],
  _sum: { revenue: true },
  orderBy: { _sum: { revenue: "desc" } },
});
// → [{ region: "EU", category: "books", _sum: { revenue: … } }, …]
```

### `having` — filter groups

`having` mirrors the accumulators with numeric comparisons (`equals`, `not`, `gt`,
`gte`, `lt`, `lte`). It runs as SQL `HAVING`, after grouping:

```ts
having: {
  _count: { gte: 3 },              // groups with at least 3 rows
  _sum:   { total: { gt: 1000 } }, // and total over 1000
}
```

### `orderBy` — sort groups

`orderBy` can sort by a grouped field, by `_count`, or by an accumulator on a field:

```ts
orderBy: { _count: "desc" }                 // most populous groups first
orderBy: { _sum: { total: "desc" } }        // by summed total
orderBy: { region: "asc" }                  // by a grouped field
```

### `take` / `skip` — top-N and paging

Combine `orderBy` + `take` for a leaderboard, or `skip`/`take` to page groups:

```ts
// top 5 customers by spend
await orders.groupBy({
  by: ["customerId"],
  _sum: { total: true },
  orderBy: { _sum: { total: "desc" } },
  take: 5,
});
```

`groupBy` requires a non-empty `by` array — an empty `by` throws `MonliteQueryError`
(use `aggregate` for whole-collection rollups).

## `distinct` — unique values

Return the distinct values of a field, optionally scoped by a `where`. Array fields are
**unwound** (each element counts), matching MongoDB's `distinct`.

```ts
await orders.distinct("status");                          // ["open", "shipped", "returned"]
await users.distinct("tags");                             // every distinct tag, arrays unwound
await users.distinct("address.city", { active: true });  // dot-path + scope
```

## Raw SQL escape hatch

When you need something the aggregation API doesn't express, drop to the underlying
SQLite handle via `db.sqlite` (a `better-sqlite3`-compatible facade — the same one the
companion packages use). Documents live in a `data` JSON column; reach into them with
`json_extract`:

```ts
const rows = db.sqlite
  .prepare(
    `SELECT json_extract(data, '$.city') AS city, COUNT(*) AS n
       FROM users
   GROUP BY city
   ORDER BY n DESC`,
  )
  .all();
```

This is local-engine only and bypasses monlite's typing, indexing hooks, and the
Postgres translation — prefer `aggregate`/`groupBy` where they fit.

## Notes & gotchas

- **Accumulators operate on numbers.** Non-numeric values for `_sum`/`_avg` contribute
  nothing; a field with no numeric values yields `null`.
- **`_count` is always cheap** — it's computed regardless and exposed only when you ask
  for it.
- **`where` filters rows, `having` filters groups.** Put row predicates in `where` (they
  can use an index); reserve `having` for post-aggregation thresholds.
- **`distinct` unwinds arrays** — `distinct("tags")` returns individual tags.
- **Same surface on Postgres.** `aggregate`, `groupBy`, and `distinct` all run on
  [`@monlite/postgres`](/packages/postgres) with identical calls and result shapes.
