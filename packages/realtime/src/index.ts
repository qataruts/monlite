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
      // Validate params BEFORE auth/stream — a bad request is then a clean 400,
      // not an in-band error written onto an already-opened SSE stream.
      const coll = url.searchParams.get("coll");
      if (!coll) {
        fail(res, 400, "missing coll");
        return;
      }
      const docId = kind === "doc" ? url.searchParams.get("id") : null;
      if (kind === "doc" && !docId) {
        fail(res, 400, "missing id");
        return;
      }
      let args: WatchArgs<any> = {};
      if (kind === "query") {
        const q = url.searchParams.get("q");
        if (q) {
          try {
            args = JSON.parse(q);
          } catch {
            fail(res, 400, "invalid q");
            return;
          }
        }
      }

      // Attach an idempotent cleanup BEFORE the (possibly async) authorize, so a
      // client that disconnects during auth still tears the subscription down —
      // otherwise the watch handle + heartbeat leak forever (unauthenticated DoS).
      let handle: WatchHandle<any> | undefined;
      // `cleanup` (attached below, before `await`) may read this while it's still
      // unset, so it must be a hoisted let seeded to undefined — not a const.
      let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (heartbeat) clearInterval(heartbeat);
        if (handle) {
          handle.stop();
          open.delete(handle);
        }
      };
      req.on("close", cleanup);
      res.on("close", cleanup);

      let ctx: RealtimeContext | null;
      try {
        ctx = await resolve(req);
      } catch (err) {
        cleanup();
        fail(res, 401, (err as Error)?.message ?? "unauthorized");
        return;
      }
      if (!ctx) {
        cleanup();
        fail(res, 401, "unauthorized");
        return;
      }
      // Client may have disconnected during the await — bail before opening.
      if (cleaned || req.destroyed || res.destroyed) {
        cleanup();
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
        if (res.writableEnded || res.destroyed) return;
        res.write(`id: ${++id}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const collection = ctx.db.collection(coll);
        handle =
          kind === "doc"
            ? collection.watchDoc(docId as string, (doc) => send({ doc }))
            : collection.watch(args, (event) => send(event));
      } catch (err) {
        send({ error: (err as Error)?.message ?? "watch failed" });
        res.end();
        cleanup();
        return;
      }
      if (cleaned) {
        // Disconnected during setup — don't leave the handle registered.
        handle.stop();
        return;
      }
      open.add(handle);
      heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
      }, heartbeatMs);
      (heartbeat as any).unref?.();
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
