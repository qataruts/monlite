import { MonliteError } from "../errors.js";
import type { Driver, DriverName, DriverOpenOptions } from "./types.js";
import { BetterSqlite3Driver } from "./better-sqlite3.js";
import { NodeSqliteDriver } from "./node-sqlite.js";

export type {
  Driver,
  DriverName,
  DriverOpenOptions,
  PreparedStatement,
} from "./types.js";

// Lazily resolve a CommonJS `require` to load the optional NATIVE SQLite drivers.
// Deliberately NOT a static `import ... from "node:module"`: that single line
// breaks browser bundlers (Vite / esbuild / webpack) even though this code path
// never runs in the browser, where a driver (e.g. @monlite/wasm's wasmDriver) is
// passed explicitly. Resolved on first native-driver load only.
let _req: ((id: string) => any) | null | undefined;
function resolveRequire(): ((id: string) => any) | null {
  // Try `process.getBuiltinModule` FIRST (Node 20.16+ / 22.3+, ESM and CJS):
  // it needs no static import and isn't affected by the bundler rewriting a bare
  // `require` into a throwing ESM shim.
  const proc: any = typeof process !== "undefined" ? process : undefined;
  const getBuiltin = proc?.getBuiltinModule;
  if (typeof getBuiltin === "function") {
    try {
      const mod = getBuiltin.call(proc, "module");
      if (mod?.createRequire) return mod.createRequire(import.meta.url);
    } catch {
      /* fall through */
    }
  }
  // Older Node: a real CommonJS `require`. In the ESM build the bundler turns
  // this into a stub that throws when called, so probe it and discard if so.
  try {
    if (typeof require === "function") {
      require.resolve("path");
      return require;
    }
  } catch {
    /* bundler require stub — unusable */
  }
  return null;
}
function req(id: string): any {
  if (_req === undefined) _req = resolveRequire();
  if (!_req) {
    throw new MonliteError(
      `Cannot load native driver "${id}" — no CommonJS require is available. In ` +
        `the browser, pass a driver explicitly (e.g. wasmDriver from @monlite/wasm).`,
    );
  }
  return _req(id);
}

function loadBetterSqlite3(): any | null {
  try {
    const mod = req("better-sqlite3");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

/** The encryption-capable drop-in for better-sqlite3 (same API). */
function loadCipherSqlite3(): any | null {
  try {
    const mod = req("better-sqlite3-multiple-ciphers");
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
  driver?: DriverName | Driver;
}

/** A custom driver instance (e.g. `@monlite/wasm`) implements this shape. */
function isDriverInstance(d: unknown): d is Driver {
  return (
    typeof d === "object" &&
    d !== null &&
    typeof (d as Driver).prepare === "function" &&
    typeof (d as Driver).exec === "function"
  );
}

/**
 * Build the SQLite driver. With `"auto"` (the default) better-sqlite3 is used
 * when installed, otherwise the built-in node:sqlite (Node >= 22.5).
 */
export function createDriver(
  filename: string,
  options: CreateDriverOptions = {},
): Driver {
  // A custom driver instance (e.g. the browser WASM driver) is used as-is.
  if (isDriverInstance(options.driver)) return options.driver;

  const choice = options.driver ?? "auto";

  // Encryption requires the better-sqlite3-multiple-ciphers drop-in.
  if (options.encryption) {
    if (choice === "node:sqlite") {
      throw new MonliteError(
        `Encryption is not supported on the node:sqlite backend. Use ` +
          `better-sqlite3 with the better-sqlite3-multiple-ciphers package.`,
      );
    }
    const cipher = loadCipherSqlite3();
    if (!cipher) {
      throw new MonliteError(
        `Encryption requires the "better-sqlite3-multiple-ciphers" package ` +
          `(a drop-in for better-sqlite3). Run ` +
          `\`npm install better-sqlite3-multiple-ciphers\`.`,
      );
    }
    return new BetterSqlite3Driver(cipher, filename, options);
  }

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
