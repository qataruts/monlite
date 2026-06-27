# @monlite/electron

Share one [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) database across an Electron app: the database lives in the **main process** (real file, native SQLite), and **renderer windows** talk to it over IPC — with **cross-window reactivity** (a write in one window refreshes live queries in the others).

```bash
npm install @monlite/core @monlite/electron better-sqlite3
```

## 1. Main process

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { createDb } from "@monlite/core";
import { exposeMonlite } from "@monlite/electron";

const db = createDb("app.db"); // the single source of truth
exposeMonlite(db, {
  ipcMain,
  broadcast: (channel, msg) =>
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, msg)),
});
```

## 2. Preload (contextBridge)

Expose a tiny transport — never the raw `ipcRenderer`:

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

## 3. Renderer

```ts
import { createRemoteDb } from "@monlite/electron";

const db = createRemoteDb((window as any).monliteIpc);

// Same async API as a local collection — forwarded over IPC:
await db.collection("todos").create({ data: { text: "buy milk", done: false } });
const open = await db.collection("todos").findMany({ where: { done: false } });

// Live across windows: refreshes when ANY window changes "todos".
const handle = db.collection("todos").watch({ where: { done: false } }, ({ results }) => {
  render(results);
});
// handle.stop() to unsubscribe.
```

## Notes

- **Security:** only an allow-list of CRUD/query methods is callable
  (`findMany`, `create`, `update`, `delete`, `count`, `groupBy`, …). Pass
  `methods` to `exposeMonlite` to widen/narrow it. Keep `contextIsolation: true`
  and expose only the transport.
- **Reactivity** is **query-level** across windows (a changed collection re-runs
  the query), which is coarser than core's in-process row-level matching — the
  right trade for crossing the process boundary.
- Mutations made **through the bridge** broadcast automatically. For writes you
  make **directly in the main process** (or via `@monlite/sync`), call the
  returned `handle.notify(collection)` to refresh renderer watchers.
- Use any native backend in the main process (`better-sqlite3` or `node:sqlite`).

MIT
