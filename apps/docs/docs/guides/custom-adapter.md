---
id: custom-adapter
title: Custom sync adapter
---

# Custom sync adapter

[`@monlite/sync`](/packages/sync) talks to any backend through a small `SyncAdapter`
interface. Implement it to replicate to a store we don't ship.

```ts
import type { SyncAdapter, Cursor, PullResult, PushResult, LocalChange } from "@monlite/sync";

class MyAdapter implements SyncAdapter {
  readonly name = "my-backend";

  // Fetch remote changes since `cursor` (null = from the beginning).
  async pull(cursor: Cursor, opts): Promise<PullResult> {
    const rows = await myBackend.changesSince(cursor, opts.collections, opts.limit);
    return { changes: rows.map(toRemoteChange), cursor: rows.at(-1)?.version ?? cursor };
  }

  // Apply local changes; return which were acked (LWW upsert by _id + version).
  async push(changes: LocalChange[]): Promise<PushResult> {
    for (const c of changes) await myBackend.upsert(c._id, c.doc, c.version, c.deleted);
    return { acked: changes };
  }

  // Optional: live streaming
  watch?(cursor, onChange, opts) { /* return an unsubscribe */ }
}
```

Each adapter stores `(_id, doc, version, deleted)` per document. monlite's engine
handles cursors, retries, conflict resolution, and tombstones — your adapter just
moves changes. The built-in `MemoryAdapter` is a complete reference
implementation.

Then wire it up like any other adapter:

```ts
sync(db, { adapter: new MyAdapter(), mode: "two-way" });
```
