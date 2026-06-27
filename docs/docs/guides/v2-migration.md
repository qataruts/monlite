---
id: v2-migration
title: Migrating to 2.0
---

# Migrating to `@monlite/core` 2.0

2.0 is a **types-only** release: stronger TypeScript inference. **Runtime behavior
is identical to 1.x** — your data, queries, and results work exactly as before.
The only thing that can change is whether your code *type-checks*.

> If you use **untyped** collections (`db.collection("users")`), nothing changes —
> they remain fully schema-free. The changes below affect **typed** collections
> only (`db.collection<User>("users")`).

## What changed

### 1. `where` / `orderBy` reject unknown fields

```ts
const users = db.collection<{ name: string; age: number }>("users");

users.findMany({ where: { age: { gte: 18 } } });   // ✅
users.findMany({ where: { naem: "Ali" } });         // ❌ 2.0: 'naem' is not a field
users.findMany({ where: { "address.city": "Doha" } }); // ✅ dot-paths still allowed
```

**Fixes:**
- It's a typo → fix it.
- The field really exists but isn't on your type → add it to `<T>`.
- It's a dynamic/nested path → use a dot-string (`"a.b"`), which stays open.
- You want schema-free → use an untyped collection, or widen the type:
  `db.collection<User & Record<string, unknown>>("users")`.

### 2. `select` narrows the return type

```ts
const rows = await users.findMany({ select: { name: true } });
rows[0].name; // ✅ string
rows[0].age;  // ❌ 2.0: 'age' was not selected
```

This is the headline feature — results now reflect exactly what you asked for.

**Fixes:**
- Select every field you read, or
- Drop `select` to get the full document, or
- If you need the full type regardless, cast: `await users.findMany({ select }) as WithId<User>[]`.

## What did *not* change

- **Runtime**: identical. No data migration, no query changes at runtime.
- **Untyped collections**: fully schema-free, as before.
- **Write payloads**: `create`/`update` `data` stay open (you can still write
  ad-hoc fields, even on typed collections).
- **Companion packages** (`@monlite/sync`, `fts`, `vector`, `kv`, `queue`, `cron`,
  `wasm`, `electron`, `studio`): unchanged APIs; they now depend on core `^2.0.0`.

## Known limits

- Per-field operator **value** types are hinted but not strictly enforced (TS
  treats all-optional operator objects structurally, so a wrong primitive may
  slip through).
- `select` keys narrow the result but aren't excess-checked (an unknown select
  key simply projects to nothing rather than erroring).

If 2.0's strictness is inconvenient right now, pin `@monlite/core@^1.4.0` — it
remains fully supported and identical at runtime.
