---
id: studio
title: "@monlite/studio"
---

# @monlite/studio — local web inspector

A tiny **local web inspector** for [monlite](/core/documents) databases — browse
collections, view documents, run filter queries, and delete records, from your
browser. Zero install, zero build step; it opens any `.db` file on the built-in
`node:sqlite` (or `better-sqlite3` if it's installed).

```bash
npx @monlite/studio app.db
# 🌙 monlite studio → http://127.0.0.1:53219
```

Open the printed URL. The left panel lists every collection with its document
count; pick one to browse its documents in a table. The filter box takes a monlite
[`where` clause](../core/queries) as JSON — e.g. `{"age":{"gte":18}}` or
`{"tags":{"has":"admin"}}` — and pages through results with Prev / Next. Unless
opened `--readonly`, you can delete a document by its `_id`.

## What it shows

- **Collections** — only real monlite collections (tables with both `_id` and
  `data` columns), each with its row count. System / internal tables (`_monlite_*`,
  FTS5 shadow tables, …) are hidden, and querying an unknown name never
  accidentally creates a table.
- **Documents** — the full document set for the selected collection, ordered by
  `_id`, 50 per page (capped at 500), with skip-based pagination.
- **Filtering** — any `where` clause as JSON, run through `findMany` /`count`, so
  it's the same query semantics as your code.

## CLI options

```
monlite-studio <db-path> [options]
  -p, --port <n>   Port to listen on (default: a random free port)
      --host <h>   Host to bind (default: 127.0.0.1 — localhost only)
      --readonly   Open the database read-only (disables delete)
  -h, --help       Show help
```

## Security

Studio exposes **full read** access (and, unless `--readonly`, **delete**) to the
database with **no authentication**, so it binds to **`127.0.0.1` only** by
default. Don't put it on a public interface; pass `--readonly` when you only need
to look, and `--host` only if you understand the exposure.

## HTTP API

The server is a small JSON API behind the bundled UI — handy if you want to drive
it yourself:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/meta` | `{ path, readonly, collections: [{ name, count }] }` |
| `GET` | `/api/docs?collection=&where=&limit=&skip=` | `{ results, total }` (`where` is JSON; `limit` ≤ 500, default 50) |
| `DELETE` | `/api/docs?collection=&id=` | `{ ok: true }` (403 when read-only) |

## Programmatic

`createStudioServer` returns a plain `http.Server` you can listen on yourself —
useful to embed the inspector behind your own auth, or to inspect an
already-open database without reopening the file:

```ts
import { createStudioServer } from "@monlite/studio";

// Open a path read-only and bind to localhost:
const server = createStudioServer("app.db", { readonly: true });
server.listen(0, "127.0.0.1");

// Or hand it a database you already have open:
const server2 = createStudioServer("app", { db });
```

### `StudioOptions`

| Option | Default | Meaning |
|---|---|---|
| `db` | — | use an already-open `Monlite` instead of opening the path |
| `readonly` | `false` | open read-only (disables delete) |
