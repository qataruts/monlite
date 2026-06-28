# @monlite/electron

Share one [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) database across an
Electron app: the database lives in the **main process** (real file, native SQLite), and
**renderer windows** talk to it over IPC — with **cross-window reactivity** (a write in one
window refreshes live queries in all other windows).

```bash
npm install @monlite/core @monlite/electron better-sqlite3
```

## Setup

### 1. Main process

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { createDb } from "@monlite/core";
import { exposeMonlite } from "@monlite/electron";

const db = createDb("app.db"); // single source of truth

exposeMonlite(db, {
  ipcMain,
  broadcast: (channel, msg) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, msg)),
});
```

### 2. Preload (contextBridge)

Expose a minimal transport — never the raw `ipcRenderer`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("monliteIpc", {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
```

### 3. Renderer

```ts
import { createRemoteDb } from "@monlite/electron";

const db = createRemoteDb((window as any).monliteIpc);

// Same async API as a local collection — all calls are forwarded over IPC
await db.collection("todos").create({ data: { text: "buy milk", done: false } });
const open = await db.collection("todos").findMany({ where: { done: false } });

// Live across windows: re-fires when ANY window changes "todos"
const handle = db.collection("todos").watch({ where: { done: false } }, ({ results }) => {
  render(results);
});
// handle.stop() to unsubscribe
```

## Notes

**Security.** Only an allowlist of CRUD/query methods is callable from the renderer
(`findMany`, `create`, `update`, `delete`, `count`, `groupBy`, …). Pass `methods` to
`exposeMonlite` to widen or narrow it. Keep `contextIsolation: true` and expose only the
transport through `contextBridge`.

**Reactivity scope.** Cross-window reactivity is query-level (a changed collection re-runs the
query), which is coarser than the in-process row-level matching in `@monlite/core` — the right
trade-off for crossing the process boundary.

**Direct main-process writes.** Mutations made through the bridge broadcast automatically. For
writes you make directly in the main process (or via `@monlite/sync`), call the handle returned
by `exposeMonlite` to notify renderer watchers: `handle.notify("todos")`.

**Backend.** Use any native backend in the main process (`better-sqlite3` or `node:sqlite`).

## License

MIT
