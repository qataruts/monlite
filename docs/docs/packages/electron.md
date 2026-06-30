---
id: electron
title: "@monlite/electron"
---

# @monlite/electron — one database across windows

Share a single monlite database across an Electron app. The database lives in the
**main process** (a real file, native SQLite); **renderer windows** talk to it
over IPC through the same async collection API — with **cross-window reactivity**,
so a write in one window refreshes live queries in all the others.

```bash
npm install @monlite/core @monlite/electron better-sqlite3
```

Two functions: `exposeMonlite(db, opts)` in the main process publishes the
database over IPC, and `createRemoteDb(transport)` in the renderer gives you a
collection API that forwards every call across the boundary.

## Main process

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { createDb } from "@monlite/core";
import { exposeMonlite } from "@monlite/electron";

const db = createDb("app.db"); // the single source of truth

const bridge = exposeMonlite(db, {
  ipcMain,
  broadcast: (channel, msg) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, msg)),
});
```

`exposeMonlite` registers one `ipcMain.handle` for the RPC channel (default
`"monlite"`) and returns an `ExposeHandle`:

```ts
bridge.notify("todos");  // broadcast a change for a main-process / sync write (see Notes)
bridge.dispose();        // remove the IPC handler
```

### `ExposeOptions`

| Option | Default | Meaning |
|---|---|---|
| `ipcMain` | — | Electron's `ipcMain` (anything with `handle` / `removeHandler`) |
| `broadcast` | — | send an event to every renderer window |
| `channel` | `"monlite"` | IPC channel base name |
| `methods` | safe CRUD/query set | allow-list of callable collection methods |

The default `methods` allow-list is the read/CRUD surface: `findMany`,
`findFirst`, `findById`, `findUnique`, `findFirstOrThrow`, `create`,
`createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `count`,
`exists`, `aggregate`, `groupBy`, `distinct`. Any method not on the list is
rejected; pass `methods` to widen or narrow it.

## Preload (contextBridge)

Expose a minimal transport to the renderer — never the raw `ipcRenderer`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("monliteIpc", {
  invoke: (channel: string, payload: unknown) => ipcRenderer.invoke(channel, payload),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
```

This shape is exactly the `RemoteTransport` interface `createRemoteDb` expects:
`invoke(channel, payload)` returning a promise, and `on(channel, listener)`
returning an unsubscribe.

## Renderer

```ts
import { createRemoteDb } from "@monlite/electron";

const db = createRemoteDb((window as any).monliteIpc);

// Same async API as a local collection — every call is forwarded over IPC.
await db.collection("todos").create({ data: { text: "buy milk", done: false } });
const open = await db.collection("todos").findMany({ where: { done: false } });

// Live across windows: re-fires when ANY window changes "todos".
const handle = db.collection("todos").watch({ where: { done: false } }, ({ type, results }) => {
  render(results); // type is "init" on first fire, then "change"
});
// handle.stop() to unsubscribe
```

`db.collection(name)` returns a `RemoteCollection`: `watch(args, cb)` is handled
locally (it re-runs `findMany` when the collection changes), and **every other
method** is proxied straight to the main process and awaited. Mutations through
the bridge automatically broadcast a change, so other windows' watchers refresh.

## Notes

- **Security.** Only the allow-listed methods are callable from a renderer; the
  handler throws for anything else. Keep `contextIsolation: true` and expose only
  the transport through `contextBridge` — never `ipcRenderer` itself.
- **Reactivity scope.** Cross-window reactivity is **query-level**: a changed
  collection causes each window's `watch()` to re-run its query. That's coarser
  than the row-level matching `@monlite/core`'s in-process `watch()` does — the
  right trade-off for crossing the process boundary, where the matcher and the
  document don't share memory.
- **Direct main-process writes.** Mutations routed **through the bridge**
  broadcast automatically. For writes you make **directly in the main process**
  (or via [`@monlite/sync`](/packages/sync)), call `bridge.notify("todos")` on
  the handle returned by `exposeMonlite`, so renderer watchers see them.
- **Backend.** Use any native backend in the main process —
  `better-sqlite3`, or the built-in `node:sqlite` on Node ≥ 22.5.
- **Custom channel.** Pass a matching `channel` to both `exposeMonlite` and
  `createRemoteDb` to run more than one bridge.

For streaming to **remote** clients (browser, mobile) rather than other windows
of the same app, use [`@monlite/realtime`](/packages/realtime).
