---
id: queries
title: Queries & operators
---

# Queries & operators

`where` is a Mongo/Prisma-style filter. For typed collections, keys are checked
against your type (dot-paths allowed).

## Comparison

```ts
where: { age: { equals: 30 } }            // or shorthand: { age: 30 }
where: { age: { gt: 18, lte: 65 } }
where: { role: { in: ["admin", "editor"] } }
where: { role: { notIn: ["guest"] } }
where: { name: { not: "Ali" } }
```

## Strings

```ts
where: { name: { contains: "li" } }                          // case-sensitive substring
where: { name: { startsWith: "A" } }
where: { name: { endsWith: "i" } }
where: { name: { contains: "ALI", mode: "insensitive" } }    // case-insensitive
```

## Regex

JavaScript `RegExp` semantics — works identically on every driver, including the browser:

```ts
where: { email: { regex: "@acme\\.com$" } }
where: { name: { regex: "^al", mode: "insensitive" } }       // or a literal: { regex: /^al/i }
```

## Arrays

```ts
where: { tags: { has: "admin" } }                            // element membership
where: { scores: { elemMatch: { gte: 90 } } }                // any scalar element matches
where: { items: { elemMatch: { sku: "A", qty: { gte: 2 } } } } // any object element ($elemMatch)
```

## Existence & nesting

```ts
where: { phone: { exists: true } }
where: { "address.city": { equals: "Riyadh" } }              // dot-path
```

## Logical

```ts
where: { AND: [{ age: { gte: 18 } }, { active: true }] }
where: { OR:  [{ role: "admin" }, { role: "editor" }] }
where: { NOT: { role: "guest" } }
where: { role: "admin", age: { gt: 30 } }                    // multiple fields ⇒ implicit AND
```

## Ordering, pagination, joins

```ts
await orders.findMany({
  where: { status: "open" },
  orderBy: [{ priority: "desc" }, { created_at: "asc" }],
  take: 50,
  skip: 100,
  // left-join another collection ($lookup); unwind: true flattens ($unwind)
  lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" },
});
```

`lookup` runs as two queries (no N+1) in both document and structured modes.
