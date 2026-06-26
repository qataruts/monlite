import { randomBytes } from "node:crypto";

/**
 * Generates MongoDB ObjectId-compatible identifiers: a 24-character hex string
 * built from a 4-byte timestamp, 5 random bytes (stable per process) and a
 * 3-byte incrementing counter.
 *
 * Because the timestamp is the high-order component, ids sort in roughly
 * insertion order — which keeps the SQLite primary-key index well-localized.
 */

const PROCESS_UNIQUE = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

export function objectId(): string {
  const time = Math.floor(Date.now() / 1000);
  counter = (counter + 1) % 0x1000000; // wrap at 2^24

  const buf = Buffer.allocUnsafe(12);
  buf.writeUInt32BE(time >>> 0, 0);
  PROCESS_UNIQUE.copy(buf, 4, 0, 5);
  buf.writeUIntBE(counter, 9, 3);

  return buf.toString("hex");
}

/** True when a value looks like a monlite/ObjectId id (24 hex chars). */
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}
