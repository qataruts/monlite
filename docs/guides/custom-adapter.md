# Guide: custom adapters & drivers

monlite has two extension seams. A **sync adapter** teaches `@monlite/sync` how to
replicate against a new backend. A **driver** teaches `@monlite/core` how to talk
to a new SQLite binding/environment. Both are small interfaces.

---

## A custom sync adapter

Implement `SyncAdapter` from `@monlite/sync`:

```ts
interface SyncAdapter {
  readonly name: string;
  pull(cursor: Cursor, opts: PullOptions): Promise<PullResult>;
  push(changes: LocalChange[]): Promise<PushResult>;
  watch?(cursor, onChange, opts): Unsubscribe; // optional live stream
}
```

Changes are `{ collection, _id, op: "upsert" | "delete", version, doc? }`. The
`version` is an opaque, lexicographically-sortable LWW token — store it and use it
as the cursor (return rows whose version is `> cursor`).

```ts
import type {
  SyncAdapter, Cursor, PullOptions, PullResult, PushResult,
  RemoteChange, LocalChange,
} from "@monlite/sync";

export class HttpAdapter implements SyncAdapter {
  readonly name = "my-api";
  constructor(private baseUrl: string) {}

  // Apply local changes to the remote. Idempotent, keyed by _id.
  async push(changes: LocalChange[]): Promise<PushResult> {
    const res = await fetch(`${this.baseUrl}/changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    if (!res.ok) return { acked: [], rejected: changes.map((c) => ({ change: c, reason: String(res.status) })) };
    return { acked: changes }; // everything the remote accepted
  }

  // Fetch remote changes after `cursor`; return them + the new cursor (max version).
  async pull(cursor: Cursor, opts: PullOptions): Promise<PullResult> {
    const url = new URL(`${this.baseUrl}/changes`);
    if (cursor) url.searchParams.set("since", cursor);
    if (opts.limit) url.searchParams.set("limit", String(opts.limit));
    const changes: RemoteChange[] = await (await fetch(url)).json();
    const cursorOut = changes.reduce((m, c) => (c.version > m ? c.version : m), cursor ?? "");
    return { changes, cursor: cursorOut || null };
  }
}

// usage
sync(db, { adapter: new HttpAdapter("https://api.example.com"), collections: ["todos"] });
```

Reference implementations to copy from: `MemoryAdapter` (simplest),
`PostgresAdapter`/`MySqlAdapter` (SQL backends), `MongoAdapter` (incl. a live
`watch()` via change streams). The engine handles batching, conflict resolution
(LWW or custom), retries/backoff, and cursor bookkeeping — your adapter only moves
changes.

---

## A custom driver

A driver is how core runs SQL. Implement `Driver` from `@monlite/core` and pass an
instance as `driver`:

```ts
interface Driver {
  readonly name: string;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
  transaction<T>(fn: () => T): T;
  close(): void;
  rekey?(key: string, cipher?: string): void; // encrypted backends only
  readonly raw: any;
}

const db = createDb(":memory:", { driver: myDriver });
```

It must be **synchronous** (core's query layer is sync). Cache prepared
statements, and implement `transaction()` with `BEGIN`/`COMMIT` (and `SAVEPOINT`
for nesting). The cleanest reference is `@monlite/wasm`, which wraps sql.js this
way — that's exactly how monlite runs in the browser.

You'd write a driver to support a **new SQLite binding or environment** (a Bun/
Deno binding, a different WASM build, an OPFS-backed browser VFS, etc.). Everything
above the driver — the query engine, reactivity, migrations, the kv/queue/cron
harness — runs unchanged.
