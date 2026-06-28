// Browser polyfill for Node's `crypto` module.
// Uses the Web Crypto API — available in all modern browsers and secure contexts.
import { Buffer } from "buffer";

export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}
