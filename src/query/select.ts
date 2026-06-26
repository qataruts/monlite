import type { Select } from "../types.js";
import { getPath, setPath } from "./path.js";

/**
 * Project a document down to the selected fields. Supports dot-notation paths,
 * reconstructing nested objects. With no select, the document is returned as-is.
 */
export function project(
  doc: Record<string, any>,
  select?: Select,
): Record<string, any> {
  if (!select) return doc;
  const keys = Object.keys(select).filter((k) => (select as any)[k]);
  if (!keys.length) return doc;

  const out: Record<string, any> = {};
  for (const key of keys) {
    const value = getPath(doc, key);
    if (value !== undefined) setPath(out, key, value);
  }
  return out;
}
