import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Monlite, WatchArgs, WatchHandle } from "@monlite/core";

/** What an authorized request resolves to: the database (tenant) to serve. */
export interface RealtimeContext {
  db: Monlite;
}

export interface RealtimeOptions {
  /**
   * Resolve the database (tenant) for a request and authorize it. Return a
   * context (`{ db }`), or `null`/throw to reject (`401`). Read a token from
   * `req.headers.authorization` / the `?token=` query param. For per-tenant
   * deployments, map the token → that tenant's `Monlite` instance.
   */
  authorize?: (
    req: IncomingMessage,
  ) => RealtimeContext | null | Promise<RealtimeContext | null>;
  /** Single-database shortcut — serve this db for every request (no auth). */
  db?: Monlite;
  /** Base path for the endpoints. Default `"/realtime"`. */
  path?: string;
  /** `Access-Control-Allow-Origin` value, or `false` to disable CORS. Default `"*"`. */
  cors?: string | false;
  /** Heartbeat comment interval (ms) to keep idle connections alive. Default `25000`. */
  heartbeatMs?: number;
}

export interface RealtimeServer {
  /** Node `http` request handler — attach to your own server or framework. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Convenience: start a standalone HTTP server. */
  listen: (port: number, cb?: () => void) => Server;
  /** Active subscription count. */
  readonly subscriptions: number;
  /** Stop all subscriptions (does not close the http server). */
  close: () => void;
}

/**
 * A realtime gateway that streams live queries and documents to remote clients
 * over Server-Sent Events, backed by `@monlite/core`'s `watch()` / change feed.
 * Zero extra dependencies — built on `node:http`.
 *
 * ```ts
 * realtime({ authorize: (req) => ({ db: dbForTenant(tokenOf(req)) }) }).listen(8080);
 * ```
 */
export function realtime(options: RealtimeOptions): RealtimeServer {
  const base = (options.path ?? "/realtime").replace(/\/$/, "");
  const cors = options.cors === undefined ? "*" : options.cors;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const open = new Set<WatchHandle<any>>();

  const resolve = async (
    req: IncomingMessage,
  ): Promise<RealtimeContext | null> => {
    if (options.authorize) return options.authorize(req);
    if (options.db) return { db: options.db };
    return null;
  };

  const setCors = (res: ServerResponse): void => {
    if (cors === false) return;
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  };

  const fail = (res: ServerResponse, code: number, msg: string): void => {
    setCors(res);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (cors !== false && req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (!url.pathname.startsWith(base + "/")) {
      fail(res, 404, "not found");
      return;
    }
    const kind = url.pathname.slice(base.length + 1); // "query" | "doc"
    if (kind !== "query" && kind !== "doc") {
      fail(res, 404, "not found");
      return;
    }

    void (async () => {
      let ctx: RealtimeContext | null;
      try {
        ctx = await resolve(req);
      } catch (err) {
        fail(res, 401, (err as Error)?.message ?? "unauthorized");
        return;
      }
      if (!ctx) {
        fail(res, 401, "unauthorized");
        return;
      }

      const coll = url.searchParams.get("coll");
      if (!coll) {
        fail(res, 400, "missing coll");
        return;
      }

      // Open the SSE stream.
      setCors(res);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": ok\n\n");
      let id = 0;
      const send = (payload: unknown): void => {
        if (res.writableEnded) return;
        res.write(`id: ${++id}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      let handle: WatchHandle<any> | undefined;
      try {
        const collection = ctx.db.collection(coll);
        if (kind === "doc") {
          const docId = url.searchParams.get("id");
          if (!docId) {
            fail(res, 400, "missing id");
            return;
          }
          handle = collection.watchDoc(docId, (doc) => send({ doc }));
        } else {
          const q = url.searchParams.get("q");
          const args: WatchArgs<any> = q ? JSON.parse(q) : {};
          handle = collection.watch(args, (event) => send(event));
        }
      } catch (err) {
        // Headers already sent; surface the error in-band, then close.
        send({ error: (err as Error)?.message ?? "watch failed" });
        res.end();
        return;
      }
      open.add(handle);

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, heartbeatMs);
      (heartbeat as any).unref?.();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        if (handle) {
          handle.stop();
          open.delete(handle);
        }
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
    })();
  };

  return {
    handler,
    listen(port, cb) {
      const server = createServer(handler);
      server.listen(port, cb);
      return server;
    },
    get subscriptions() {
      return open.size;
    },
    close() {
      for (const h of open) h.stop();
      open.clear();
    },
  };
}
