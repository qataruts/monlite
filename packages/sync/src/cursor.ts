// Per-collection sync cursor for version-cursor adapters (postgres/mysql/mongo).
//
// These adapters page each collection by `version > cursor LIMIT n`. A single
// GLOBAL cursor is unsafe: if collection A's versions run ahead of B's, advancing
// the cursor to the global max permanently skips B's rows whose version sits
// below that max but wasn't returned (LIMIT cut it off). Tracking a cursor PER
// collection fixes this — each collection only advances past what it returned.
//
// The cursor stays an opaque string at the engine/store layer; we JSON-encode the
// per-collection map. A legacy scalar cursor (from before this change) is treated
// as the floor for every collection, so upgrades don't re-pull or skip.

export type PerCollectionCursor = Record<string, string>;

export interface DecodedCursor {
  perColl: PerCollectionCursor;
  legacy: string;
}

export function decodeCursor(cursor: string | null | undefined): DecodedCursor {
  if (!cursor) return { perColl: {}, legacy: "" };
  if (cursor[0] === "{") {
    try {
      const obj = JSON.parse(cursor) as PerCollectionCursor;
      if (obj && typeof obj === "object") return { perColl: obj, legacy: "" };
    } catch {
      /* fall through to legacy */
    }
  }
  return { perColl: {}, legacy: cursor };
}

/** The starting version for a collection: its own cursor, else the legacy floor. */
export function cursorFor(decoded: DecodedCursor, collection: string): string {
  return decoded.perColl[collection] ?? decoded.legacy ?? "";
}

export function encodeCursor(perColl: PerCollectionCursor): string {
  return JSON.stringify(perColl);
}
