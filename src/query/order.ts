import type { OrderBy } from "../types.js";
import { fieldExpr, isColumn } from "./sql.js";

/** Build an `ORDER BY` clause from an orderBy spec. Returns "" when empty. */
export function buildOrderBy(
  orderBy: OrderBy | undefined,
  onPath?: (p: string) => void,
  columns?: Set<string>,
): string {
  if (!orderBy) return "";

  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];

  for (const obj of list) {
    for (const field of Object.keys(obj)) {
      const dir = (obj as any)[field];
      if (dir === undefined) continue;
      if (onPath && !isColumn(field, columns)) onPath(field);
      const d = String(dir).toLowerCase() === "desc" ? "DESC" : "ASC";
      parts.push(`${fieldExpr(field, columns)} ${d}`);
    }
  }

  return parts.length ? "ORDER BY " + parts.join(", ") : "";
}
