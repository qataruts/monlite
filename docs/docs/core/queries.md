---
id: queries
title: Queries & operators
---

# Queries & operators

`where` is a Mongo/Prisma-style filter object. Every read method — `findMany`,
`findFirst`, `count`, `exists`, `distinct`, `aggregate`, `groupBy`, `update*`,
`delete*` — accepts the same `where` shape.

```ts
const orders = db.collection<Order>("orders");

await orders.findMany({
  where: {
    status: "pending",                 // shorthand equals
    total: { gte: 50 },                // operator object
    items: { elemMatch: { sku: "WIDGET", qty: { gte: 5 } } },
  },
});
```

For a **typed** collection, keys are checked against your type (an unknown field is a
type error); dot-notation nested paths stay open. For an **untyped** collection any
field is accepted. The entire `where`/`orderBy`/`select` surface in this page runs
**identically on the [Postgres engine](/packages/postgres)** — the same collection
code translates to JSONB SQL there.

## Shorthand

A bare value is shorthand for `{ equals: value }`:

```ts
where: { status: "pending" }          // ≡ { status: { equals: "pending" } }
where: { active: true, role: "admin" } // multiple fields ⇒ implicit AND
```

## Comparison operators

| Operator | Matches |
|---|---|
| `equals` | Equal (the shorthand). `equals: null` matches null/missing. |
| `not` | Not equal. A **missing** field counts as "not equal" (Mongo/Prisma semantics). |
| `gt` / `gte` | Greater than / greater-or-equal. |
| `lt` / `lte` | Less than / less-or-equal. |
| `in` | Value is in the given array. |
| `notIn` | Value is not in the array — includes null/missing rows. |

```ts
where: { age: { equals: 30 } }                 // or shorthand: { age: 30 }
where: { age: { gte: 18, lt: 65 } }            // range — combined with AND
where: { role: { in: ["admin", "editor"] } }
where: { role: { notIn: ["guest"] } }
where: { name: { not: "Ada" } }
where: { deletedAt: { equals: null } }         // null OR missing
```

`in`/`notIn` handle `null` in the list correctly (a SQL `IN (NULL)` would otherwise
silently drop matches): a `null` in `in` also matches null/missing rows, and `notIn`
keeps null/missing rows.

## String operators

| Operator | Matches |
|---|---|
| `contains` | Substring (case-sensitive). On an array field, element membership. |
| `startsWith` | Prefix. |
| `endsWith` | Suffix. |
| `regex` | JavaScript `RegExp` match. |
| `mode: "insensitive"` | Makes `contains`/`startsWith`/`endsWith` case-insensitive (ASCII). |

```ts
where: { name: { contains: "li" } }                       // case-sensitive substring
where: { name: { startsWith: "A" } }
where: { email: { endsWith: "@acme.com" } }
where: { name: { contains: "ADA", mode: "insensitive" } } // case-insensitive
```

`contains` uses literal matching (not SQL `LIKE`), so `%` and `_` are treated as plain
characters. `contains` on an array field tests element membership rather than substring.

### Regex

`regex` runs JavaScript `RegExp` semantics — identically on every driver, including the
browser. Pass a pattern string or a literal `RegExp` (whose `i`/`m`/`s` flags are
honoured); pair a string with `mode: "insensitive"` for the `i` flag.

```ts
where: { email: { regex: "@acme\\.com$" } }
where: { name: { regex: "^ad", mode: "insensitive" } }
where: { name: { regex: /^ad/i } }            // literal RegExp — flags honoured
```

## Array operators

| Operator | Matches |
|---|---|
| `has` | The array contains this exact element. |
| `elemMatch` | **Any** element satisfies a sub-filter (Mongo `$elemMatch`). |

```ts
// element membership
where: { tags: { has: "admin" } }

// any scalar element matches a sub-filter
where: { scores: { elemMatch: { gte: 90 } } }

// any object element matches across nested fields
where: { items: { elemMatch: { sku: "WIDGET", qty: { gte: 2 } } } }
```

For an array of scalars, `elemMatch` applies the sub-filter to the element itself
(`{ gte: 3 }`); for an array of objects it applies per nested field
(`{ name: "x", level: { gte: 3 } }`). Inside `elemMatch` the supported operators are
the comparison set (`equals`, `not`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`).

## Existence

```ts
where: { phone: { exists: true } }    // the field is present
where: { phone: { exists: false } }   // the field is absent (or JSON null)
```

## Nested paths (dot notation)

Reach into nested objects with a dot-path string key. This works in `where`, `orderBy`,
and `select`.

```ts
where: { "address.city": "Riyadh" }
where: { "profile.settings.theme": { in: ["dark", "system"] } }
orderBy: { "address.city": "asc" }
select: { "address.city": true }
```

## Logical operators

`AND`, `OR`, and `NOT` compose sub-filters. Each takes a single filter or an array of
filters. Multiple fields at the top level are an implicit `AND`.

```ts
where: { AND: [{ age: { gte: 18 } }, { active: true }] }
where: { OR:  [{ role: "admin" }, { role: "editor" }] }
where: { NOT: { role: "guest" } }                 // also matches docs missing `role`
where: { role: "admin", age: { gt: 30 } }         // implicit AND across fields

// nested composition
where: {
  status: "open",
  OR: [{ priority: "high" }, { assignee: { exists: true } }],
}
```

`NOT` matches documents where the field is missing or null too (consistent with the
`not` field operator and document-DB semantics). An empty `OR: []` matches nothing;
an empty `AND: []` imposes no constraint.

## Ordering — `orderBy`

A single object or an array of objects (applied in order). Direction is `"asc"` or
`"desc"`. System fields and dot-paths are sortable.

```ts
orderBy: { created_at: "desc" }
orderBy: [{ priority: "desc" }, { created_at: "asc" }]  // tie-break
orderBy: { "address.city": "asc" }
```

## Pagination — `take` / `skip`

`take` is the limit; `skip` is the offset.

```ts
const page = 3, pageSize = 20;
await orders.findMany({
  where: { status: "open" },
  orderBy: { created_at: "desc" },
  take: pageSize,
  skip: (page - 1) * pageSize,
});
```

For large collections, prefer **keyset (cursor) pagination** over `skip` — it stays
fast as the offset grows because it seeks instead of counting past skipped rows:

```ts
// first page
const first = await orders.findMany({ orderBy: { created_at: "desc" }, take: 20 });
// next page — start strictly after the last seen timestamp
const next = await orders.findMany({
  where: { created_at: { lt: first.at(-1)!.created_at } },
  orderBy: { created_at: "desc" },
  take: 20,
});
```

(Use a strictly-monotonic field, or combine `created_at` with `_id` as a tie-breaker,
to avoid skipping rows that share a timestamp.)

## Projection — `select`

`select` narrows the returned fields (and the return type on a typed collection). See
[Documents & CRUD](/core/documents#projection--select) for details.

```ts
await users.findMany({ where: { active: true }, select: { name: true, email: true } });
```

## Joins — `lookup`

`lookup` is a `$lookup`-style left join: for each result, fetch matching documents from
another collection and attach them under `as`. It runs as **two queries** (no N+1).

```ts
await orders.findMany({
  where: { status: "open" },
  lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" },
});
// each order → { …order, user: [ …matching user docs ] }
```

Pass an **array** of specs for multiple joins. `unwind: true` flattens the `as` array to
one output row per match (`$unwind`); `unwind: "preserve"` also keeps rows that have no
match (left-outer behaviour).

```ts
lookup: [
  { from: "users", localField: "userId", foreignField: "_id", as: "user", unwind: true },
  { from: "lineItems", localField: "_id", foreignField: "orderId", as: "items" },
]
```

`lookup` is a SQLite-engine feature; it is not yet available on the Postgres engine.

## Notes & gotchas

- **`not` and `NOT` match missing fields.** In document-DB semantics a document with no
  `role` *is* "not 'guest'", so it matches `{ role: { not: "guest" } }`.
- **`contains` is literal, not `LIKE`.** `%`/`_` are matched as plain characters.
- **`exists: false` includes JSON null**, not only an absent key.
- **Auto-indexing.** A JSON path queried often enough (default after 10 reads) gets a
  SQLite index created automatically — no manual index management for hot paths.
- **Same surface on Postgres.** This whole operator set (except `lookup`) runs on
  [`@monlite/postgres`](/packages/postgres) against JSONB, with the same calls.
