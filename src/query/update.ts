import type { UpdateData } from "../types.js";
import { MonliteQueryError } from "../errors.js";
import { getPath, setPath, unsetPath } from "./path.js";

const UPDATE_OPS = new Set(["$set", "$unset", "$inc", "$push", "$pull"]);

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
    for (const [path, value] of Object.entries(ops.$set)) setPath(next, path, value);
  }
  if (ops.$inc) {
    for (const [path, by] of Object.entries(ops.$inc)) {
      const cur = getPath(next, path);
      setPath(next, path, (typeof cur === "number" ? cur : 0) + Number(by));
    }
  }
  if (ops.$push) {
    for (const [path, value] of Object.entries(ops.$push)) {
      const cur = getPath(next, path);
      const arr = Array.isArray(cur) ? cur.slice() : [];
      // `{ $each: [...] }` pushes multiple values.
      if (value && typeof value === "object" && Array.isArray((value as any).$each)) {
        arr.push(...(value as any).$each);
      } else {
        arr.push(value);
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
