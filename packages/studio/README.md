# @monlite/studio

A tiny **local web inspector** for [monlite](https://www.npmjs.com/package/@monlite/core) databases — browse collections, view documents, run filter queries, and delete records, from your browser. Zero build step, runs on the built-in `node:sqlite` (or `better-sqlite3` if installed).

```bash
npx @monlite/studio app.db
# 🌙 monlite studio → http://127.0.0.1:53219
```

Open the printed URL. The left panel lists your collections (with counts); pick
one to browse its documents. The filter box takes a monlite `where` clause as
JSON (e.g. `{"age":{"gte":18}}`); paginate with Prev/Next.

## Options

```
monlite-studio <db-path> [options]
  -p, --port <n>   Port to listen on (default: a random free port)
      --host <h>   Host to bind (default: 127.0.0.1 — localhost only)
      --readonly   Open read-only (disables delete)
  -h, --help       Show help
```

It only identifies real monlite collections (tables with `_id` + `data`), so
system/internal tables (`_monlite_*`, FTS shadows, …) are hidden, and an unknown
collection never accidentally creates a table.

## Security

Studio exposes **full read** (and, unless `--readonly`, **delete**) access to the
database with no auth, so it binds to **`127.0.0.1` only** by default. Don't put
it on a public interface.

## Programmatic

```ts
import { createStudioServer } from "@monlite/studio";

const server = createStudioServer("app.db", { readonly: true });
server.listen(0, "127.0.0.1");
// or pass an already-open db: createStudioServer("label", { db })
```

MIT
