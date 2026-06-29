import type { WhereInput, FieldFilter } from "../types.js";
import { MonliteQueryError } from "../errors.js";
import { fieldExpr, pathLiteral, bindable, isColumn, isBuffer } from "./sql.js";
import { REGEXP_FN } from "../driver/regexp.js";

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
      const arr = asArray(value);
      const subs = arr
        .map((w: WhereInput) => translateObject(w, ctx))
        .filter(Boolean);
      if (subs.length) {
        const join = key === "AND" ? " AND " : " OR ";
        parts.push("(" + subs.join(join) + ")");
      } else if (key === "OR" && arr.length === 0) {
        // An empty OR is an unsatisfiable disjunction — it matches NOTHING (an
        // empty AND, by contrast, is vacuously true and imposes no constraint).
        parts.push("0");
      }
    } else if (key === "NOT") {
      const subs = asArray(value)
        .map((w: WhereInput) => translateObject(w, ctx))
        .filter(Boolean);
      // COALESCE(..., 0): a missing/null field makes the inner predicate NULL in
      // SQL, and `NOT NULL` is NULL (the row is dropped). Treat a NULL inner as
      // FALSE so NOT still matches missing/null-field docs — consistent with the
      // `not` field operator and document-DB semantics (a missing `n` IS "not 5").
      if (subs.length)
        parts.push("NOT COALESCE((" + subs.join(" AND ") + "), 0)");
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
    !isBuffer(v) &&
    (v.constructor === Object || v.constructor === undefined)
  );
}

function translateField(
  field: string,
  condition: any,
  ctx: WhereContext,
): string {
  if (ctx.onPath && !isColumn(field, ctx.columns)) ctx.onPath(field);
  const expr = fieldExpr(field, ctx.columns);

  // Scalar (or array/Date) value is shorthand for `{ equals: value }`.
  if (!isFilterObject(condition)) {
    return eqExpr(expr, condition, ctx);
  }

  const filter = condition as Record<string, any>;
  const ci = filter.mode === "insensitive";
  const clauses: string[] = [];
  for (const op of Object.keys(filter)) {
    const v = filter[op];
    if (v === undefined || op === "mode") continue;

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
        clauses.push(containsExpr(field, expr, v, ctx, ci));
        break;
      case "startsWith":
        ctx.params.push(bindable(v));
        clauses.push(
          ci ? `instr(lower(${expr}), lower(?)) = 1` : `instr(${expr}, ?) = 1`,
        );
        break;
      case "endsWith":
        if (v === "") {
          // every string ends with "" — match all non-null values, consistent
          // with startsWith:""/contains:"" (substr(x,-0) otherwise matches nothing).
          clauses.push(`${expr} IS NOT NULL`);
          break;
        }
        ctx.params.push(bindable(v));
        ctx.params.push(bindable(v));
        clauses.push(
          ci
            ? `substr(lower(${expr}), -length(?)) = lower(?)`
            : `substr(${expr}, -length(?)) = ?`,
        );
        break;
      case "regex":
        clauses.push(regexExpr(expr, v, ci, ctx));
        break;
      case "has":
        clauses.push(hasExpr(field, expr, v, ctx));
        break;
      case "elemMatch":
        clauses.push(elemMatchExpr(expr, v, ctx));
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

/**
 * `elemMatch` — true if **any** element of the array field satisfies a sub-filter.
 * For arrays of scalars the sub-filter applies to the element (`{ gte: 3 }`); for
 * arrays of objects it applies per nested field (`{ name: "x", level: { gte: 3 } }`).
 */
function elemMatchExpr(arrayExpr: string, sub: any, ctx: WhereContext): string {
  const scalarOps = new Set([
    "equals",
    "not",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "notIn",
  ]);
  const cond = (base: string, c: any): string => {
    if (!isFilterObject(c)) return eqExpr(base, c, ctx);
    const rc = c as Record<string, any>;
    const parts: string[] = [];
    for (const op of Object.keys(rc)) {
      const v = rc[op];
      if (v === undefined) continue;
      switch (op) {
        case "equals":
          parts.push(eqExpr(base, v, ctx));
          break;
        case "not":
          parts.push(notExpr(base, v, ctx));
          break;
        case "gt":
          parts.push(cmp(base, ">", v, ctx));
          break;
        case "gte":
          parts.push(cmp(base, ">=", v, ctx));
          break;
        case "lt":
          parts.push(cmp(base, "<", v, ctx));
          break;
        case "lte":
          parts.push(cmp(base, "<=", v, ctx));
          break;
        case "in":
          parts.push(inExpr(base, v, ctx, false));
          break;
        case "notIn":
          parts.push(inExpr(base, v, ctx, true));
          break;
        default:
          throw new MonliteQueryError(
            `Unsupported operator "${op}" inside elemMatch`,
          );
      }
    }
    return parts.length === 1 ? parts[0]! : "(" + parts.join(" AND ") + ")";
  };

  let where: string;
  if (isFilterObject(sub)) {
    const rec = sub as Record<string, any>;
    const keys = Object.keys(rec);
    const isScalar = keys.length > 0 && keys.every((k) => scalarOps.has(k));
    where = isScalar
      ? cond("value", rec) // array of scalars
      : keys
          .map((f) => cond(`json_extract(value, ${pathLiteral(f)})`, rec[f]))
          .join(" AND ") || "1";
  } else {
    where = eqExpr("value", sub, ctx);
  }
  return `EXISTS (SELECT 1 FROM json_each(${arrayExpr}) WHERE ${where})`;
}

/**
 * `regex` — JavaScript-`RegExp` match via the registered `monlite_regexp` SQL
 * function. Accepts a pattern string or a `RegExp` (whose `i`/`m`/`s` flags are
 * honoured); `mode: "insensitive"` adds the `i` flag.
 */
function regexExpr(
  expr: string,
  v: any,
  ci: boolean,
  ctx: WhereContext,
): string {
  let source: string;
  let flags: string;
  if (v instanceof RegExp) {
    source = v.source;
    flags = [...v.flags].filter((f) => "ims".includes(f)).join("");
    if (ci && !flags.includes("i")) flags += "i";
  } else {
    source = String(v);
    flags = ci ? "i" : "";
  }
  ctx.params.push(source);
  ctx.params.push(flags);
  return `${REGEXP_FN}(?, ${expr}, ?)`;
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
    throw new MonliteQueryError(`${negate ? "notIn" : "in"} expects an array`);
  }
  if (arr.length === 0) return negate ? "1" : "0";
  // A NULL inside a SQL IN / NOT IN makes the whole predicate NULL for every other
  // row (three-valued logic), silently dropping legitimate matches. Bind only the
  // non-null values and handle null membership explicitly.
  const hasNull = arr.some((v) => v === null);
  const nonNull = arr.filter((v) => v !== null);
  const placeholders = nonNull
    .map((v) => {
      ctx.params.push(bindable(v));
      return "?";
    })
    .join(", ");
  if (negate) {
    // notIn includes null/missing rows (Prisma/Mongo); a list-null never corrupts it.
    if (!nonNull.length) return hasNull ? `${expr} IS NOT NULL` : "1";
    return `(${expr} IS NULL OR ${expr} NOT IN (${placeholders}))`;
  }
  if (!nonNull.length) return hasNull ? `${expr} IS NULL` : "0";
  return hasNull
    ? `(${expr} IN (${placeholders}) OR ${expr} IS NULL)`
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
  ci: boolean,
): string {
  const sub = ci
    ? `instr(lower(${expr}), lower(?)) > 0`
    : `instr(${expr}, ?) > 0`;
  const member = ci ? `lower(value) = lower(?)` : `value = ?`;
  if (isColumn(field, ctx.columns)) {
    // A declared column may hold a JSON array (membership) or a string (substring).
    ctx.params.push(bindable(v)); // array branch
    ctx.params.push(bindable(v)); // string branch
    return (
      `(CASE WHEN json_valid(${expr}) AND json_type(${expr}) = 'array' ` +
      `THEN EXISTS (SELECT 1 FROM json_each(${expr}) WHERE ${member}) ` +
      `ELSE ${sub} END)`
    );
  }
  const path = pathLiteral(field);
  ctx.params.push(bindable(v)); // array branch
  ctx.params.push(bindable(v)); // string branch
  return (
    `(CASE WHEN json_type(data, ${path}) = 'array' ` +
    `THEN EXISTS (SELECT 1 FROM json_each(data, ${path}) WHERE ${member}) ` +
    `ELSE ${sub} END)`
  );
}

function hasExpr(
  field: string,
  expr: string,
  v: any,
  ctx: WhereContext,
): string {
  if (isColumn(field, ctx.columns)) {
    // A declared column may hold a JSON array (membership) or a scalar (equality).
    ctx.params.push(bindable(v)); // membership branch
    ctx.params.push(bindable(v)); // scalar fallback
    return (
      `(CASE WHEN json_valid(${expr}) AND json_type(${expr}) = 'array' ` +
      `THEN EXISTS (SELECT 1 FROM json_each(${expr}) WHERE value = ?) ` +
      `ELSE ${expr} = ? END)`
    );
  }
  ctx.params.push(bindable(v));
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
