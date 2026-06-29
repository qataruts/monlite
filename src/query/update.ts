import type { UpdateData } from "../types.js";
import { MonliteQueryError } from "../errors.js";
import { getPath, setPath, unsetPath } from "./path.js";

const UPDATE_OPS = new Set([
  "$set",
  "$unset",
  "$inc",
  "$push",
  "$addToSet",
  "$pull",
]);

/** True when the payload uses update operators rather than plain fields. */
export function isUpdateOperators(data: any): boolean {
  return (
    data != null &&
    typeof data === "object" &&
    Object.keys(data).some((k) => k.startsWith("$"))
  );
}

function sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply an update payload to a (system-field-free) document, returning a new
 * document. Plain payloads are shallow-merged; operator payloads ($set, $inc,
 * $push, $pull, $unset) are applied in order.
 */
export function applyUpdate(
  doc: Record<string, any>,
  data: UpdateData,
): Record<string, any> {
  const next = structuredClone(doc);

  if (!isUpdateOperators(data)) {
    return Object.assign(next, data);
  }

  for (const key of Object.keys(data)) {
    if (!key.startsWith("$")) {
      throw new MonliteQueryError(
        `Cannot mix update operators with plain field "${key}". ` +
          `Use either a plain object or update operators, not both.`,
      );
    }
    if (!UPDATE_OPS.has(key)) {
      throw new MonliteQueryError(`Unknown update operator "${key}"`);
    }
  }

  const ops = data as Record<string, Record<string, any>>;

  if (ops.$set) {
    for (const [path, value] of Object.entries(ops.$set)) {
      if (path === "_id") {
        throw new MonliteQueryError("Cannot $set the immutable _id field");
      }
      setPath(next, path, value);
    }
  }
  if (ops.$inc) {
    for (const [path, by] of Object.entries(ops.$inc)) {
      if (typeof by !== "number" || !Number.isFinite(by)) {
        throw new MonliteQueryError(
          `$inc on "${path}" requires a finite number, got ${JSON.stringify(by)}`,
        );
      }
      const cur = getPath(next, path);
      if (cur != null && typeof cur !== "number") {
        throw new MonliteQueryError(
          `$inc on "${path}" requires a numeric target, but it holds ${JSON.stringify(cur)}`,
        );
      }
      setPath(next, path, (typeof cur === "number" ? cur : 0) + by);
    }
  }
  if (ops.$push) {
    for (const [path, value] of Object.entries(ops.$push)) {
      const cur = getPath(next, path);
      if (cur != null && !Array.isArray(cur)) {
        throw new MonliteQueryError(
          `$push on "${path}" requires an array target, but it holds ${JSON.stringify(cur)}`,
        );
      }
      const arr = Array.isArray(cur) ? cur.slice() : [];
      // `{ $each: [...] }` pushes multiple values.
      if (
        value &&
        typeof value === "object" &&
        Array.isArray((value as any).$each)
      ) {
        arr.push(...(value as any).$each);
      } else {
        arr.push(value);
      }
      setPath(next, path, arr);
    }
  }
  if (ops.$addToSet) {
    for (const [path, value] of Object.entries(ops.$addToSet)) {
      const cur = getPath(next, path);
      if (cur != null && !Array.isArray(cur)) {
        throw new MonliteQueryError(
          `$addToSet on "${path}" requires an array target, but it holds ${JSON.stringify(cur)}`,
        );
      }
      const arr = Array.isArray(cur) ? cur.slice() : [];
      const toAdd =
        value &&
        typeof value === "object" &&
        Array.isArray((value as any).$each)
          ? (value as any).$each
          : [value];
      for (const v of toAdd) {
        if (!arr.some((x) => sameValue(x, v))) arr.push(v);
      }
      setPath(next, path, arr);
    }
  }
  if (ops.$pull) {
    for (const [path, value] of Object.entries(ops.$pull)) {
      const cur = getPath(next, path);
      if (Array.isArray(cur)) {
        setPath(
          next,
          path,
          cur.filter((x) => !sameValue(x, value)),
        );
      }
    }
  }
  if (ops.$unset) {
    for (const path of Object.keys(ops.$unset)) unsetPath(next, path);
  }

  return next;
}
