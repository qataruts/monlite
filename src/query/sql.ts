/** Shared helpers for translating document paths and values into SQLite. */

import { MonliteQueryError } from "../errors.js";

/** System columns stored outside the JSON `data` blob. */
export const RESERVED_FIELDS = new Set(["_id", "created_at", "updated_at"]);

export function isReserved(field: string): boolean {
  return RESERVED_FIELDS.has(field);
}

/**
 * True when a field maps to a real SQL column: a system field, or — in a
 * structured collection — one of its declared columns. Such fields are
 * referenced directly instead of via `json_extract`.
 */
export function isColumn(field: string, columns?: Set<string>): boolean {
  return isReserved(field) || (columns?.has(field) ?? false);
}

/**
 * Convert a dotted document path (`address.city`, `items.0.name`) into a
 * SQLite JSON path (`$.address.city`, `$.items[0].name`), quoting segments
 * that are not bare identifiers.
 */
export function jsonPath(field: string): string {
  let path = "$";
  for (const seg of field.split(".")) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) {
      path += "." + seg;
    } else if (/^\d+$/.test(seg)) {
      path += "[" + seg + "]";
    } else {
      // A quoted JSON-path label is a JSON string: escape \ and " the JSON way
      // (backslash), NOT with SQL quote-doubling — otherwise a key containing a
      // double-quote or backslash builds an invalid path and silently matches nothing.
      path += '."' + seg.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
  }
  return path;
}

/** A JSON path wrapped as a single-quoted SQL string literal. */
export function pathLiteral(field: string): string {
  return "'" + jsonPath(field).replace(/'/g, "''") + "'";
}

/**
 * SQL expression yielding the value of `field` for a row. System fields and
 * declared structured columns resolve to a bare column; everything else is
 * read from the `data` JSON blob via `json_extract`.
 */
export function fieldExpr(field: string, columns?: Set<string>): string {
  if (isColumn(field, columns)) return quoteIdent(field);
  // A dotted path whose ROOT is a declared column reads into that column's JSON
  // (e.g. `obj.k` on a JSON column `obj` → json_extract("obj", '$.k')), not `data`.
  const dot = field.indexOf(".");
  if (dot > 0) {
    const root = field.slice(0, dot);
    if (columns?.has(root)) {
      return `json_extract(${quoteIdent(root)}, ${pathLiteral(field.slice(dot + 1))})`;
    }
  }
  return `json_extract(data, ${pathLiteral(field)})`;
}

/** Quote a SQL identifier, doubling embedded quotes (defense-in-depth). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a safe Postgres JSONB accessor for a (possibly dotted) document field —
 * chained `->`/`->>` over single-quoted keys (the last hop is `->>` when `text`).
 * Each key is a quoted string literal, so a comma, brace or backslash in a key is
 * harmless — unlike the `data#>>'{a,b}'` array-literal form, which those characters
 * would structurally corrupt.
 */
export function pgJsonbPath(field: string, text: boolean): string {
  const keys = field.split(".").map((s) => `'${s.replace(/'/g, "''")}'`);
  const last = keys.length - 1;
  return (
    "data" + keys.map((k, i) => (text && i === last ? "->>" : "->") + k).join("")
  );
}

/**
 * Normalize a JS value into something better-sqlite3 can bind.
 * better-sqlite3 only accepts numbers, bigints, strings, Buffers and null —
 * so booleans, Dates, undefined and objects are converted here.
 */
/** Browser-safe `Buffer.isBuffer` — `Buffer` is undefined outside Node. */
export function isBuffer(value: unknown): boolean {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

export function bindable(value: any): number | bigint | string | Buffer | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    // node:sqlite truncates a TEXT value at an embedded NUL byte (\u0000) while
    // better-sqlite3 preserves it — reject it so data isn't silently lost across
    // drivers. (JSON columns are stringified first, which escapes any NUL safely.)
    if (value.includes("\u0000")) {
      throw new MonliteQueryError(
        "Cannot store a string containing a NUL byte (\\u0000) — it is unsupported by SQLite TEXT.",
      );
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (isBuffer(value)) return value;
  // Arrays / nested objects: compare against SQLite's minified JSON text.
  return JSON.stringify(value);
}
