/**
 * Generates MongoDB ObjectId-compatible identifiers: a 24-character hex string
 * built from a 4-byte timestamp, 5 random bytes (stable per process) and a
 * 3-byte incrementing counter.
 *
 * Because the timestamp is the high-order component, ids sort in roughly
 * insertion order — which keeps the SQLite primary-key index well-localized.
 *
 * Runtime-agnostic: uses the Web Crypto API (`globalThis.crypto`, present in
 * Node >= 18 and all browsers) and typed arrays — no `node:crypto` or `Buffer`,
 * so the same code runs under the wasm driver in the browser.
 */

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < n; i++) a[i] = (Math.random() * 256) | 0;
  return a;
}

const PROCESS_UNIQUE = randomBytes(5);
const seed = randomBytes(3);
let counter = (seed[0] << 16) | (seed[1] << 8) | seed[2];

export function objectId(): string {
  const time = Math.floor(Date.now() / 1000);
  counter = (counter + 1) % 0x1000000; // wrap at 2^24

  const buf = new Uint8Array(12);
  buf[0] = (time >>> 24) & 0xff;
  buf[1] = (time >>> 16) & 0xff;
  buf[2] = (time >>> 8) & 0xff;
  buf[3] = time & 0xff;
  buf.set(PROCESS_UNIQUE, 4);
  buf[9] = (counter >>> 16) & 0xff;
  buf[10] = (counter >>> 8) & 0xff;
  buf[11] = counter & 0xff;

  let hex = "";
  for (let i = 0; i < 12; i++) hex += HEX[buf[i]];
  return hex;
}

/** True when a value looks like a monlite/ObjectId id (24 hex chars). */
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}
