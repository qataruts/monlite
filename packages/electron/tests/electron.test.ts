import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "@monlite/core";
import { exposeMonlite, createRemoteDb } from "../src/index";

// An in-process stand-in for Electron IPC: wires ipcMain.handle <-> invoke and
// broadcast <-> on, so the bridge can be tested without an Electron runtime.
function mockIpc() {
  let handler: ((event: any, payload: any) => any) | undefined;
  const changeListeners = new Set<(payload: any) => void>();
  return {
    ipcMain: {
      handle(_channel: string, listener: (e: any, p: any) => any) {
        handler = listener;
      },
      removeHandler() {
        handler = undefined;
      },
    },
    broadcast: (_channel: string, payload: any) => {
      for (const l of [...changeListeners]) l(payload);
    },
    transport: {
      invoke: async (_channel: string, payload: any) => {
        if (!handler) throw new Error("no handler registered");
        return handler({}, payload);
      },
      on: (_channel: string, listener: (p: any) => void) => {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
      },
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let main: Monlite;
afterEach(async () => {
  if (main) await main.$disconnect();
});

describe("@monlite/electron", () => {
  it("forwards CRUD from a renderer to the main-process db", async () => {
    main = createDb(":memory:");
    const { ipcMain, broadcast, transport } = mockIpc();
    const handle = exposeMonlite(main, { ipcMain, broadcast });
    const db = createRemoteDb(transport);

    await db.collection("todos").create({ data: { _id: "t1", text: "hi" } });
    expect(await db.collection("todos").findMany({})).toHaveLength(1);
    expect((await db.collection("todos").findById("t1")).text).toBe("hi");
    // it really wrote to the main-process database
    expect(await main.collection("todos").count()).toBe(1);
    handle.dispose();
  });

  it("refreshes a window's watch when another window writes", async () => {
    main = createDb(":memory:");
    const { ipcMain, broadcast, transport } = mockIpc();
    exposeMonlite(main, { ipcMain, broadcast });
    const winA = createRemoteDb(transport);
    const winB = createRemoteDb(transport);

    const events: any[] = [];
    const h = winB
      .collection("todos")
      .watch({ orderBy: { _id: "asc" } }, (e) => events.push(e));
    await sleep(10);
    expect(events[0].type).toBe("init");
    expect(events[0].results).toHaveLength(0);

    await winA.collection("todos").create({ data: { _id: "t1", text: "x" } });
    await sleep(10);
    const last = events[events.length - 1];
    expect(last.type).toBe("change");
    expect(last.results).toHaveLength(1);
    h.stop();
  });

  it("rejects methods outside the allow-list", async () => {
    main = createDb(":memory:");
    const { ipcMain, broadcast, transport } = mockIpc();
    exposeMonlite(main, { ipcMain, broadcast });
    const db = createRemoteDb(transport);
    await expect((db.collection("x") as any).backup("/tmp/y")).rejects.toThrow(
      /not allowed/,
    );
  });

  it("notify() propagates main-process writes to watchers", async () => {
    main = createDb(":memory:");
    const { ipcMain, broadcast, transport } = mockIpc();
    const handle = exposeMonlite(main, { ipcMain, broadcast });
    const db = createRemoteDb(transport);

    const events: any[] = [];
    db.collection("notes").watch({}, (e) => events.push(e));
    await sleep(10);

    await main
      .collection("notes")
      .create({ data: { _id: "n1", text: "direct" } });
    handle.notify("notes");
    await sleep(10);
    expect(events[events.length - 1].results).toHaveLength(1);
  });
});
