import type { WhereInput, FieldFilter } from "../types.js";
import { MonliteQueryError } from "../errors.js";
import { fieldExpr, pathLiteral, bindable, isColumn } from "./sql.js";

export interface WhereContext {
  params: any[];
  /** Declared native columns (structured collections). */
  columns?: Set<string>;
  /** Called with every document path referenced (for auto-index tracking). */
  onPath?: (path: string) => void;
}

/** Build a SQL boolean expression from a where clause. Returns `1` when empty. */
export function buildWhere(
  where: WhereInput | undefined,
  ctx: WhereContext,
): string {
  if (!where) return "1";
  return translateObject(where, ctx) || "1";
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function translateObject(where: WhereInput, ctx: WhereContext): string {
  const parts: string[] = [];

  for (const key of Object.keys(where)) {
    const value = (where as any)[key];
    if (value === undefined) continue;

    if (key === "AND" || key === "OR") {
      const subs = asArray(value)
        .map((w: WhereInput) => translateObject(w, ctx))
        .filter(Boolean);
      if (subs.length) {
        const join = key === "AND" ? " AND " : " OR ";
        parts.push("(" + subs.join(join) + ")");
      }
    } else if (key === "NOT") {
      const subs = asArray(value)
        .map((w: WhereInput) => translateObject(w, ctx))
        .filter(Boolean);
      if (subs.length) parts.push("NOT (" + subs.join(" AND ") + ")");
    } else {
      const clause = translateField(key, value, ctx);
      if (clause) parts.push(clause);
    }
  }

  return parts.join(" AND ");
}

function isFilterObject(v: any): v is FieldFilter {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !Buffer.isBuffer(v) &&
    (v.constructor === Object || v.constructor === undefined)
  );
}

function translateField(field: string, condition: any, ctx: WhereContext): string {
  if (ctx.onPath && !isColumn(field, ctx.columns)) ctx.onPath(field);
  const expr = fieldExpr(field, ctx.columns);

  // Scalar (or array/Date) value is shorthand for `{ equals: value }`.
  if (!isFilterObject(condition)) {
    return eqExpr(expr, condition, ctx);
  }

  const filter = condition as Record<string, any>;
  const clauses: string[] = [];
  for (const op of Object.keys(filter)) {
    const v = filter[op];
    if (v === undefined) continue;

    switch (op) {
      case "equals":
        clauses.push(eqExpr(expr, v, ctx));
        break;
      case "not":
        clauses.push(notExpr(expr, v, ctx));
        break;
      case "gt":
        clauses.push(cmp(expr, ">", v, ctx));
        break;
      case "gte":
        clauses.push(cmp(expr, ">=", v, ctx));
        break;
      case "lt":
        clauses.push(cmp(expr, "<", v, ctx));
        break;
      case "lte":
        clauses.push(cmp(expr, "<=", v, ctx));
        break;
      case "in":
        clauses.push(inExpr(expr, v, ctx, false));
        break;
      case "notIn":
        clauses.push(inExpr(expr, v, ctx, true));
        break;
      case "contains":
        clauses.push(containsExpr(field, expr, v, ctx));
        break;
      case "startsWith":
        ctx.params.push(bindable(v));
        clauses.push(`instr(${expr}, ?) = 1`);
        break;
      case "endsWith":
        ctx.params.push(bindable(v));
        ctx.params.push(bindable(v));
        clauses.push(`substr(${expr}, -length(?)) = ?`);
        break;
      case "has":
        clauses.push(hasExpr(field, expr, v, ctx));
        break;
      case "exists":
        clauses.push(existsExpr(field, expr, !!v, ctx.columns));
        break;
      default:
        throw new MonliteQueryError(
          `Unknown where operator "${op}" on field "${field}"`,
        );
    }
  }

  if (!clauses.length) return "";
  return clauses.length === 1 ? clauses[0]! : "(" + clauses.join(" AND ") + ")";
}

function eqExpr(expr: string, v: any, ctx: WhereContext): string {
  if (v === null) return `${expr} IS NULL`;
  ctx.params.push(bindable(v));
  return `${expr} = ?`;
}

function notExpr(expr: string, v: any, ctx: WhereContext): string {
  // Mongo/Prisma semantics: a missing field counts as "not equal".
  if (v === null) return `${expr} IS NOT NULL`;
  ctx.params.push(bindable(v));
  return `(${expr} IS NULL OR ${expr} != ?)`;
}

function cmp(expr: string, op: string, v: any, ctx: WhereContext): string {
  ctx.params.push(bindable(v));
  return `${expr} ${op} ?`;
}

function inExpr(
  expr: string,
  arr: any,
  ctx: WhereContext,
  negate: boolean,
): string {
  if (!Array.isArray(arr)) {
    throw new MonliteQueryError(
      `${negate ? "notIn" : "in"} expects an array`,
    );
  }
  if (arr.length === 0) return negate ? "1" : "0";
  const placeholders = arr
    .map((v) => {
      ctx.params.push(bindable(v));
      return "?";
    })
    .join(", ");
  return negate
    ? `(${expr} IS NULL OR ${expr} NOT IN (${placeholders}))`
    : `${expr} IN (${placeholders})`;
}

/**
 * `contains` works on strings (case-sensitive substring via `instr`) and arrays
 * (element membership). `instr` is used instead of `LIKE` so that `%`/`_` are
 * treated literally and matching is case-sensitive, matching Prisma semantics.
 */
function containsExpr(
  field: string,
  expr: string,
  v: any,
  ctx: WhereContext,
): string {
  if (isColumn(field, ctx.columns)) {
    ctx.params.push(bindable(v));
    return `instr(${expr}, ?) > 0`;
  }
  const path = pathLiteral(field);
  ctx.params.push(bindable(v)); // array branch
  ctx.params.push(bindable(v)); // string branch
  return (
    `(CASE WHEN json_type(data, ${path}) = 'array' ` +
    `THEN EXISTS (SELECT 1 FROM json_each(data, ${path}) WHERE value = ?) ` +
    `ELSE instr(${expr}, ?) > 0 END)`
  );
}

function hasExpr(
  field: string,
  expr: string,
  v: any,
  ctx: WhereContext,
): string {
  ctx.params.push(bindable(v));
  if (isColumn(field, ctx.columns)) return `${expr} = ?`;
  return `EXISTS (SELECT 1 FROM json_each(data, ${pathLiteral(field)}) WHERE value = ?)`;
}

function existsExpr(
  field: string,
  expr: string,
  want: boolean,
  columns?: Set<string>,
): string {
  if (isColumn(field, columns)) {
    return want ? `${expr} IS NOT NULL` : `${expr} IS NULL`;
  }
  const path = pathLiteral(field);
  return want
    ? `json_type(data, ${path}) IS NOT NULL`
    : `json_type(data, ${path}) IS NULL`;
}
