import type { Monlite } from "@monlite/core";

const DEFAULT_CHANNEL = "monlite";

/** Methods a renderer may call. Override via `methods` to widen/narrow. */
const DEFAULT_METHODS = [
  "findMany",
  "findFirst",
  "findById",
  "findUnique",
  "findFirstOrThrow",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "exists",
  "aggregate",
  "groupBy",
  "distinct",
] as const;

const MUTATIONS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

interface RpcPayload {
  collection: string;
  method: string;
  args: any[];
}

/* ------------------------------- main process ------------------------------ */

export interface ExposeOptions {
  /** Electron's `ipcMain` (or any object with `handle`/`removeHandler`). */
  ipcMain: {
    handle(
      channel: string,
      listener: (event: any, payload: RpcPayload) => any,
    ): void;
    removeHandler(channel: string): void;
  };
  /**
   * Send an event to every renderer window, e.g.
   * `(ch, msg) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send(ch, msg))`.
   */
  broadcast: (channel: string, payload: { collection: string }) => void;
  /** IPC channel base name. Default `"monlite"`. */
  channel?: string;
  /** Allow-list of callable collection methods. Default: the safe CRUD/query set. */
  methods?: readonly string[];
}

export interface ExposeHandle {
  /** Broadcast a change for main-process (or sync-originated) writes. */
  notify(collection: string): void;
  /** Remove the IPC handler. */
  dispose(): void;
}

/**
 * Expose a monlite database (living in the Electron **main** process) to renderer
 * windows over IPC. Renderers talk to it via {@link createRemoteDb}. Mutations
 * routed through the bridge automatically broadcast a change so other windows'
 * live queries refresh; for writes you make directly in the main process (or via
 * sync), call {@link ExposeHandle.notify}.
 */
export function exposeMonlite(db: Monlite, opts: ExposeOptions): ExposeHandle {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  const changeChannel = `${channel}:change`;
  const allow = new Set<string>(opts.methods ?? DEFAULT_METHODS);

  opts.ipcMain.handle(channel, async (_event, payload: RpcPayload) => {
    const { collection, method, args } = payload ?? ({} as RpcPayload);
    if (!allow.has(method)) {
      throw new Error(`@monlite/electron: method "${method}" is not allowed`);
    }
    const coll = db.collection(collection) as unknown as Record<string, any>;
    const fn = coll[method];
    if (typeof fn !== "function") {
      throw new Error(`@monlite/electron: unknown method "${method}"`);
    }
    const result = await fn.apply(coll, args ?? []);
    if (MUTATIONS.has(method)) opts.broadcast(changeChannel, { collection });
    return result;
  });

  return {
    notify(collection: string) {
      opts.broadcast(changeChannel, { collection });
    },
    dispose() {
      opts.ipcMain.removeHandler(channel);
    },
  };
}

/* ------------------------------ renderer side ------------------------------ */

export interface RemoteTransport {
  /** Invoke an RPC (wire to `ipcRenderer.invoke`). */
  invoke(channel: string, payload: RpcPayload): Promise<any>;
  /** Subscribe to change events (wire to `ipcRenderer.on`); returns unsubscribe. */
  on(
    channel: string,
    listener: (payload: { collection: string }) => void,
  ): () => void;
}

export interface RemoteWatchEvent<T = any> {
  type: "init" | "change";
  results: T[];
}

export interface RemoteWatchHandle {
  stop(): void;
}

export interface RemoteCollection {
  watch<T = any>(
    args: Record<string, any>,
    cb: (event: RemoteWatchEvent<T>) => void,
  ): RemoteWatchHandle;
  // Every other collection method is forwarded over IPC and returns a Promise.
  [method: string]: (...args: any[]) => any;
}

export interface RemoteDb {
  collection(name: string): RemoteCollection;
}

/**
 * Create a renderer-side handle to the main-process monlite database. Every
 * collection method is forwarded over IPC and awaited; `watch()` re-runs its
 * query whenever the collection changes (query-level, across windows).
 *
 * ```ts
 * // preload (contextBridge) wires ipcRenderer into a RemoteTransport, then:
 * const db = createRemoteDb(transport);
 * await db.collection("todos").create({ data: { text: "hi" } });
 * db.collection("todos").watch({ where: { done: false } }, (e) => render(e.results));
 * ```
 */
export function createRemoteDb(
  transport: RemoteTransport,
  opts: { channel?: string } = {},
): RemoteDb {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  const changeChannel = `${channel}:change`;
  const watchers = new Map<string, Set<() => void>>();
  let unsub: (() => void) | undefined;

  function ensureSubscription(): void {
    if (unsub) return;
    unsub = transport.on(changeChannel, (payload) => {
      const set = watchers.get(payload.collection);
      if (set) for (const run of [...set]) run();
    });
  }

  function collection(name: string): RemoteCollection {
    const watch: RemoteCollection["watch"] = (args, cb) => {
      ensureSubscription();
      let stopped = false;
      let first = true;
      const run = async () => {
        const results = await transport.invoke(channel, {
          collection: name,
          method: "findMany",
          args: [args ?? {}],
        });
        if (stopped) return;
        cb({ type: first ? "init" : "change", results });
        first = false;
      };
      let set = watchers.get(name);
      if (!set) watchers.set(name, (set = new Set()));
      set.add(run);
      void run();
      return {
        stop() {
          stopped = true;
          set!.delete(run);
        },
      };
    };

    return new Proxy(
      { watch },
      {
        get(target, prop) {
          if (prop === "watch") return target.watch;
          // Avoid being treated as a thenable, and ignore symbol access.
          if (typeof prop !== "string" || prop === "then") return undefined;
          return (...args: any[]) =>
            transport.invoke(channel, { collection: name, method: prop, args });
        },
      },
    ) as RemoteCollection;
  }

  return { collection };
}
