import { createRequire } from "node:module";
import { MonliteError } from "../errors.js";
import type { Driver, DriverName, DriverOpenOptions } from "./types.js";
import { BetterSqlite3Driver } from "./better-sqlite3.js";
import { NodeSqliteDriver } from "./node-sqlite.js";

export type { Driver, DriverName, DriverOpenOptions, PreparedStatement } from "./types.js";

// Resolve relative to this module so optional deps load from the host app.
const req = createRequire(import.meta.url);

function loadBetterSqlite3(): any | null {
  try {
    const mod = req("better-sqlite3");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

function loadNodeSqlite(): any | null {
  try {
    // Only required when actually selected, so better-sqlite3 users never
    // trigger node:sqlite's experimental warning.
    return req("node:sqlite");
  } catch {
    return null;
  }
}

export interface CreateDriverOptions extends DriverOpenOptions {
  driver?: DriverName;
}

/**
 * Build the SQLite driver. With `"auto"` (the default) better-sqlite3 is used
 * when installed, otherwise the built-in node:sqlite (Node >= 22.5).
 */
export function createDriver(
  filename: string,
  options: CreateDriverOptions = {},
): Driver {
  const choice = options.driver ?? "auto";

  if (choice === "better-sqlite3") {
    const mod = loadBetterSqlite3();
    if (!mod) {
      throw new MonliteError(
        `driver "better-sqlite3" was requested but the package is not installed. ` +
          `Run \`npm install better-sqlite3\`.`,
      );
    }
    return new BetterSqlite3Driver(mod, filename, options);
  }

  if (choice === "node:sqlite") {
    const mod = loadNodeSqlite();
    if (!mod) {
      throw new MonliteError(
        `driver "node:sqlite" is unavailable. It requires Node >= 22.5.`,
      );
    }
    return new NodeSqliteDriver(mod, filename, options);
  }

  // auto: prefer better-sqlite3 (stable, all Node versions), else node:sqlite.
  const better = loadBetterSqlite3();
  if (better) return new BetterSqlite3Driver(better, filename, options);

  const node = loadNodeSqlite();
  if (node) return new NodeSqliteDriver(node, filename, options);

  throw new MonliteError(
    `No SQLite driver available. Either install better-sqlite3 ` +
      `(\`npm install better-sqlite3\`) or run on Node >= 22.5 for the ` +
      `built-in node:sqlite backend.`,
  );
}
