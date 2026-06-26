import { createDb, type MonliteOptions } from "../src/index";

/**
 * Open an in-memory test database. The backend can be forced with the
 * `MONLITE_DRIVER` env var (`better-sqlite3` | `node:sqlite`) so CI can run the
 * whole suite against both adapters; otherwise it defaults to `"auto"`.
 */
export function openDb(options: MonliteOptions = {}) {
  const envDriver = process.env.MONLITE_DRIVER as MonliteOptions["driver"] | undefined;
  return createDb(":memory:", {
    ...(envDriver ? { driver: envDriver } : {}),
    ...options,
  });
}
