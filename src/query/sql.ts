/** Shared helpers for translating document paths and values into SQLite. */

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
      path += '."' + seg.replace(/"/g, '""') + '"';
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
  if (isColumn(field, columns)) return `"${field}"`;
  return `json_extract(data, ${pathLiteral(field)})`;
}

/**
 * Normalize a JS value into something better-sqlite3 can bind.
 * better-sqlite3 only accepts numbers, bigints, strings, Buffers and null —
 * so booleans, Dates, undefined and objects are converted here.
 */
export function bindable(value: any): number | bigint | string | Buffer | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (Buffer.isBuffer(value)) return value;
  // Arrays / nested objects: compare against SQLite's minified JSON text.
  return JSON.stringify(value);
}
