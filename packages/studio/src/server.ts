import http from "node:http";
import { createDb, type Monlite } from "@monlite/core";
import { PAGE } from "./ui.js";

export interface StudioOptions {
  /** Use an already-open database instead of opening `dbPath`. */
  db?: Monlite;
  /** Open the database read-only (disables delete). Default false. */
  readonly?: boolean;
}

/** Tables that are monlite collections (have `_id` + `data` columns). */
function listCollections(db: Monlite): string[] {
  const tables = db.driver
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  const out: string[] = [];
  for (const { name } of tables) {
    const cols = (
      db.driver.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    if (cols.includes("_id") && cols.includes("data")) out.push(name);
  }
  return out.sort();
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Build a local inspector HTTP server for a monlite database. Bind it to
 * `127.0.0.1` only — it exposes full read (and, unless `readonly`, delete) access.
 */
export function createStudioServer(
  dbPath: string,
  opts: StudioOptions = {},
): http.Server {
  const db = opts.db ?? createDb(dbPath, { readonly: opts.readonly });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }

      if (req.method === "GET" && path === "/api/meta") {
        const collections = listCollections(db).map((name) => ({
          name,
          count: (
            db.driver.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {
              n: number;
            }
          ).n,
        }));
        send(res, 200, {
          path: dbPath,
          readonly: !!opts.readonly,
          collections,
        });
        return;
      }

      if (path === "/api/docs") {
        const collection = url.searchParams.get("collection") ?? "";
        if (!listCollections(db).includes(collection)) {
          send(res, 404, { error: `unknown collection "${collection}"` });
          return;
        }
        const coll = db.collection(collection);

        if (req.method === "GET") {
          let where: any;
          const whereRaw = url.searchParams.get("where");
          if (whereRaw) {
            try {
              where = JSON.parse(whereRaw);
            } catch {
              send(res, 400, { error: "where must be valid JSON" });
              return;
            }
          }
          const take = Math.min(
            Number(url.searchParams.get("limit")) || 50,
            500,
          );
          const skip = Number(url.searchParams.get("skip")) || 0;
          const results = await coll.findMany({
            where,
            take,
            skip,
            orderBy: { _id: "asc" },
          });
          const total = await coll.count(where ? { where } : {});
          send(res, 200, { results, total });
          return;
        }

        if (req.method === "DELETE") {
          if (opts.readonly) {
            send(res, 403, { error: "database is read-only" });
            return;
          }
          const id = url.searchParams.get("id") ?? "";
          await coll.delete({ where: { _id: id } });
          send(res, 200, { ok: true });
          return;
        }
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: String((err as Error)?.message ?? err) });
    }
  });
}
