import type {
  Doc,
  LiveEvent,
  WatchArgs,
  WhereInput,
  WithId,
} from "@monlite/core";

export interface RealtimeClientOptions {
  /** Bearer token sent as `Authorization` (and `?token=` for EventSource-style auth). */
  token?: string;
  /** Base path on the server. Default `"/realtime"`. */
  path?: string;
  /** Reconnect backoff in ms after a dropped stream. Default `1000`. */
  reconnectMs?: number;
  /** Custom `fetch` (e.g. for Node < 18 or a proxy). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Called for a server-sent `{ error }` frame. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

/** Unsubscribe from a live stream. */
export type Unsubscribe = () => void;

export interface QueryBuilder<T = Doc> {
  where(where: WhereInput<T>): QueryBuilder<T>;
  orderBy(orderBy: WatchArgs<T>["orderBy"]): QueryBuilder<T>;
  take(n: number): QueryBuilder<T>;
  skip(n: number): QueryBuilder<T>;
  /** Only emit when one of these fields changes (server-side filter). */
  fields(fields: (keyof T | (string & {}))[]): QueryBuilder<T>;
  /** Subscribe. The callback fires with each {@link LiveEvent} (init, then changes). */
  onSnapshot(cb: (event: LiveEvent<T>) => void): Unsubscribe;
}

export interface RealtimeClient {
  /** Live query over a collection. */
  collection<T = Doc>(name: string): QueryBuilder<T>;
  /** Live single-document listener (`null` while absent / on delete). */
  doc<T = Doc>(
    name: string,
    id: string,
    cb: (doc: WithId<T> | null) => void,
  ): Unsubscribe;
  /** Close all subscriptions. */
  close(): void;
}

/**
 * Connect to a `@monlite/realtime` server and subscribe to live queries and
 * documents over SSE. Works in the browser and Node ≥ 18 (uses `fetch`).
 *
 * ```ts
 * const live = connectRealtime("http://localhost:8080", { token });
 * const stop = live.collection("orders").where({ status: "open" }).onSnapshot(render);
 * const stopDoc = live.doc("orders", "o-123", (doc) => render(doc));
 * ```
 */
export function connectRealtime(
  baseUrl: string,
  opts: RealtimeClientOptions = {},
): RealtimeClient {
  const root = baseUrl.replace(/\/$/, "");
  const base = (opts.path ?? "/realtime").replace(/\/$/, "");
  const reconnectMs = opts.reconnectMs ?? 1000;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const subs = new Set<Unsubscribe>();

  /** Open an auto-reconnecting SSE stream; returns an unsubscribe. */
  function stream(path: string, onMessage: (data: any) => void): Unsubscribe {
    let stopped = false;
    let controller: AbortController | undefined;

    const url = new URL(root + base + path);
    if (opts.token) url.searchParams.set("token", opts.token);

    (async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await doFetch(url.toString(), {
            headers: opts.token
              ? { authorization: `Bearer ${opts.token}` }
              : {},
            signal: controller.signal,
          });
          if (!res.ok || !res.body)
            throw new Error(`realtime HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          // Tolerate LF, CRLF and CR frame/line separators (SSE permits all).
          const FRAME_SEP = /\r\n\r\n|\n\n|\r\r/;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let m: RegExpExecArray | null;
            while ((m = FRAME_SEP.exec(buf))) {
              const frame = buf.slice(0, m.index);
              buf = buf.slice(m.index + m[0].length);
              const data = frame
                .split(/\r\n|\n|\r/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue; // comment/heartbeat (":" lines) → ignore
              let parsed: any;
              try {
                parsed = JSON.parse(data);
              } catch {
                continue; // malformed frame
              }
              if (parsed && typeof parsed === "object" && "error" in parsed) {
                (
                  opts.onError ??
                  ((e: unknown) => console.error("realtime:", e))
                )(parsed.error);
              } else {
                onMessage(parsed);
              }
            }
          }
        } catch {
          /* network/abort — fall through to reconnect */
        }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, reconnectMs));
      }
    })();

    const unsub: Unsubscribe = () => {
      stopped = true;
      controller?.abort();
      subs.delete(unsub);
    };
    subs.add(unsub);
    return unsub;
  }

  function buildQuery<T>(name: string): QueryBuilder<T> {
    const args: WatchArgs<T> = {};
    const api: QueryBuilder<T> = {
      where(w) {
        args.where = w;
        return api;
      },
      orderBy(o) {
        args.orderBy = o;
        return api;
      },
      take(n) {
        args.take = n;
        return api;
      },
      skip(n) {
        args.skip = n;
        return api;
      },
      fields(f) {
        args.fields = f;
        return api;
      },
      onSnapshot(cb) {
        const qp = `?coll=${encodeURIComponent(name)}&q=${encodeURIComponent(
          JSON.stringify(args),
        )}`;
        return stream(`/query${qp}`, (data) => cb(data as LiveEvent<T>));
      },
    };
    return api;
  }

  return {
    collection<T = Doc>(name: string) {
      return buildQuery<T>(name);
    },
    doc<T = Doc>(
      name: string,
      id: string,
      cb: (doc: WithId<T> | null) => void,
    ): Unsubscribe {
      const qp = `?coll=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`;
      return stream(`/doc${qp}`, (data) =>
        cb((data?.doc ?? null) as WithId<T> | null),
      );
    },
    close() {
      for (const unsub of [...subs]) unsub();
    },
  };
}
