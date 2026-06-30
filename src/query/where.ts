import type { WhereInput, FieldFilter } from "../types.js";
import { MonliteQueryError } from "../errors.js";
import {
  fieldExpr,
  pathLiteral,
  bindable,
  isColumn,
  isBuffer,
  quoteIdent,
  pgJsonbPath,
} from "./sql.js";
import { REGEXP_FN } from "../driver/regexp.js";

export interface WhereContext {
  params: any[];
  /** Declared native columns (structured collections). */
  columns?: Set<string>;
  /** Called with every document path referenced (for auto-index tracking). */
  onPath?: (path: string) => void;
  /**
   * SQL dialect to emit. Default (`undefined`/`"sqlite"`) is unchanged SQLite. When
   * `"postgres"`, leaf fields route to {@link pgTranslateField} (JSONB) — the SQLite
   * path is byte-for-byte untouched, so existing behavior is identical.
   */
  dialect?: "sqlite" | "postgres";
}

/** Build a SQL boolean expression from a where clause. Returns the dialect's "always true". */
export function buildWhere(
  where: WhereInput | undefined,
  ctx: WhereContext,
): string {
  const empty = ctx.dialect === "postgres" ? "true" : "1";
  if (!where) return empty;
  return translateObject(where, ctx) || empty;
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
        // SQLite has no boolean type (0); Postgres rejects `WHERE 0` (needs FALSE).
        parts.push(ctx.dialect === "postgres" ? "FALSE" : "0");
      }
    } else if (key === "NOT") {
      const subs = asArray(value)
        .map((w: WhereInput) => translateObject(w, ctx))
        .filter(Boolean);
      // COALESCE(..., FALSE): a missing/null field makes the inner predicate NULL in
      // SQL, and `NOT NULL` is NULL (the row is dropped). Treat a NULL inner as
      // FALSE so NOT still matches missing/null-field docs — consistent with the
      // `not` field operator and document-DB semantics (a missing `n` IS "not 5").
      // SQLite has no boolean type (uses 0); Postgres is strict (needs FALSE).
      if (subs.length) {
        const falsy = ctx.dialect === "postgres" ? "FALSE" : "0";
        parts.push("NOT COALESCE((" + subs.join(" AND ") + "), " + falsy + ")");
      }
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

// Coerce numeric `_id` query operands to strings (scalar, equals/not/gt/…, in/notIn).
function coerceId(c: any): any {
  const s = (x: any) => (typeof x === "number" ? String(x) : x);
  if (c === null || typeof c !== "object" || c instanceof Date || isBuffer(c)) {
    return s(c);
  }
  if (Array.isArray(c)) return c.map(s);
  const out: Record<string, any> = {};
  for (const [op, v] of Object.entries(c)) {
    out[op] = Array.isArray(v) ? v.map(s) : s(v);
  }
  return out;
}

function translateField(
  field: string,
  condition: any,
  ctx: WhereContext,
): string {
  // `_id` is always stored as a string, so coerce numeric query values to match
  // (create() accepts `_id: 123` and stores "123"; this makes queries find it).
  if (field === "_id") condition = coerceId(condition);
  if (ctx.onPath && !isColumn(field, ctx.columns)) ctx.onPath(field);
  // Postgres dialect: emit JSONB SQL via a separate path. Everything below is the
  // original, unchanged SQLite emitter (so the SQLite output is provably identical).
  if (ctx.dialect === "postgres") return pgTranslateField(field, condition, ctx);
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

// ── Postgres (JSONB) dialect ─────────────────────────────────────────────────
// Selected by `ctx.dialect === "postgres"`; emits JSONB SQL parallel to the SQLite
// emitters above, which are untouched. Placeholders stay "?" (the Postgres driver
// rewrites "?" → $1,$2,…); values bind natively (number→numeric, string→text,
// boolean→boolean). Equality goes through `to_jsonb(?::type)` so it matches the
// typed comparison SQLite's `json_extract` gives. Validated against live Postgres
// (plan/postgres-prototype). NOTE: the one subtle invariant is type handling —
// `->>'f'` is text, so numeric compares cast, and equality compares jsonb values.
const PG_CMP: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

function pgType(v: any): "numeric" | "boolean" | "text" {
  return typeof v === "number"
    ? "numeric"
    : typeof v === "boolean"
      ? "boolean"
      : "text";
}

/** Field projection for Postgres: `text` → `->>` (text), else `->` (jsonb). */
function pgField(
  field: string,
  columns: Set<string> | undefined,
  text: boolean,
): string {
  if (isColumn(field, columns)) return quoteIdent(field);
  return pgJsonbPath(field, text);
}

function pgRegexSource(v: any): string {
  return v instanceof RegExp ? v.source : String(v);
}

/** Translate one field's condition to Postgres JSONB SQL (the dialect == "postgres" path). */
function pgTranslateField(
  field: string,
  condition: any,
  ctx: WhereContext,
): string {
  const P = (v: any): string => {
    ctx.params.push(v);
    return "?";
  };

  // Native column (system _id/created_at/updated_at, or a declared structured column).
  if (isColumn(field, ctx.columns)) {
    const col = quoteIdent(field);
    if (!isFilterObject(condition)) {
      return condition === null ? `${col} IS NULL` : `${col} = ${P(condition)}`;
    }
    const f = condition as Record<string, any>;
    const ci = f.mode === "insensitive";
    const out: string[] = [];
    for (const op of Object.keys(f)) {
      const v = f[op];
      if (v === undefined || op === "mode") continue;
      if (op === "equals")
        out.push(v === null ? `${col} IS NULL` : `${col} = ${P(v)}`);
      else if (op === "not")
        out.push(
          v === null
            ? `${col} IS NOT NULL`
            : `(${col} IS NULL OR ${col} <> ${P(v)})`,
        );
      else if (PG_CMP[op]) out.push(`${col} ${PG_CMP[op]} ${P(v)}`);
      else if (op === "in")
        out.push(v.length ? `${col} IN (${v.map(P).join(", ")})` : "false");
      else if (op === "notIn")
        out.push(
          v.length
            ? `(${col} IS NULL OR ${col} NOT IN (${v.map(P).join(", ")}))`
            : "true",
        );
      else if (op === "contains")
        out.push(
          ci
            ? `${col} ILIKE '%'||${P(v)}||'%'`
            : `position(${P(v)} in ${col}) > 0`,
        );
      else if (op === "startsWith")
        out.push(
          ci
            ? `${col} ILIKE ${P(v)}||'%'`
            : `left(${col}, length(${P(v)})) = ${P(v)}`,
        );
      else if (op === "endsWith")
        out.push(
          v === ""
            ? `${col} IS NOT NULL`
            : ci
              ? `${col} ILIKE '%'||${P(v)}`
              : `right(${col}, length(${P(v)})) = ${P(v)}`,
        );
      else if (op === "regex")
        out.push(`${col} ${ci ? "~*" : "~"} ${P(pgRegexSource(v))}`);
      else if (op === "exists") out.push(v ? "TRUE" : "FALSE");
      else
        throw new MonliteQueryError(
          `Operator "${op}" is not supported on column "${field}" (postgres)`,
        );
    }
    return out.length === 1 ? out[0]! : "(" + out.join(" AND ") + ")";
  }

  // JSONB document field.
  const txt = pgField(field, ctx.columns, true);
  const jsn = pgField(field, ctx.columns, false);
  if (!isFilterObject(condition)) {
    return condition === null
      ? `(${jsn} IS NULL OR ${jsn} = 'null'::jsonb)`
      : `${jsn} = to_jsonb(${P(condition)}::${pgType(condition)})`;
  }
  const f = condition as Record<string, any>;
  const ci = f.mode === "insensitive";
  const out: string[] = [];
  for (const op of Object.keys(f)) {
    const v = f[op];
    if (v === undefined || op === "mode") continue;
    switch (op) {
      case "equals":
        out.push(
          v === null
            ? `(${jsn} IS NULL OR ${jsn} = 'null'::jsonb)`
            : `${jsn} = to_jsonb(${P(v)}::${pgType(v)})`,
        );
        break;
      case "not":
        // not:null is the symmetric negation of equals:null (absent OR json-null) —
        // it matches a present, non-null value, the same as SQLite.
        out.push(
          v === null
            ? `(${jsn} IS NOT NULL AND ${jsn} <> 'null'::jsonb)`
            : `(${jsn} IS NULL OR ${jsn} <> to_jsonb(${P(v)}::${pgType(v)}))`,
        );
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        out.push(
          typeof v === "number"
            ? `(${txt})::numeric ${PG_CMP[op]} ${P(v)}`
            : `${txt} ${PG_CMP[op]} ${P(v)}`,
        );
        break;
      case "in": {
        // Match SQLite: a null in the list matches absent / json-null documents
        // (a bare `to_jsonb(null)` would be SQL NULL and never match via IN).
        const nn = (v as any[]).filter((x) => x !== null);
        const alts: string[] = [];
        if (nn.length)
          alts.push(
            `${jsn} IN (${nn.map((x) => `to_jsonb(${P(x)}::${pgType(x)})`).join(", ")})`,
          );
        if ((v as any[]).some((x) => x === null))
          alts.push(`${jsn} IS NULL`, `${jsn} = 'null'::jsonb`);
        out.push(alts.length ? `(${alts.join(" OR ")})` : "false");
        break;
      }
      case "notIn":
        out.push(
          v.length
            ? `(${jsn} IS NULL OR ${jsn} NOT IN (${v.map((x: any) => `to_jsonb(${P(x)}::${pgType(x)})`).join(", ")}))`
            : "true",
        );
        break;
      case "contains":
        // Match SQLite: element membership for a JSONB array, substring for a scalar.
        out.push(
          `(CASE WHEN jsonb_typeof(${jsn}) = 'array' THEN (${jsn} @> to_jsonb(${P(v)}::${pgType(v)})) ELSE (${
            ci
              ? `${txt} ILIKE '%'||${P(v)}||'%'`
              : `position(${P(v)} in ${txt}) > 0`
          }) END)`,
        );
        break;
      case "startsWith":
        out.push(
          ci
            ? `${txt} ILIKE ${P(v)}||'%'`
            : `left(${txt}, length(${P(v)})) = ${P(v)}`,
        );
        break;
      case "endsWith":
        out.push(
          v === ""
            ? `${txt} IS NOT NULL`
            : ci
              ? `${txt} ILIKE '%'||${P(v)}`
              : `right(${txt}, length(${P(v)})) = ${P(v)}`,
        );
        break;
      case "regex":
        out.push(`${txt} ${ci ? "~*" : "~"} ${P(pgRegexSource(v))}`);
        break;
      case "has":
        out.push(`${jsn} @> to_jsonb(${P(v)}::${pgType(v)})`);
        break;
      case "elemMatch":
        out.push(pgElemMatch(jsn, v, ctx));
        break;
      case "exists":
        // Match SQLite: "exists" means the key is present — a present json-null
        // counts as existing (data->'f' is SQL NULL only when the key is absent).
        out.push(v ? `${jsn} IS NOT NULL` : `${jsn} IS NULL`);
        break;
      default:
        throw new MonliteQueryError(
          `Unknown where operator "${op}" on field "${field}" (postgres)`,
        );
    }
  }
  if (!out.length) return "";
  return out.length === 1 ? out[0]! : "(" + out.join(" AND ") + ")";
}

/** `elemMatch` for Postgres: any element of a JSONB array satisfies a sub-filter. */
function pgElemMatch(arrayJsn: string, sub: any, ctx: WhereContext): string {
  const P = (v: any): string => {
    ctx.params.push(v);
    return "?";
  };
  const SCALAR = new Set([
    "equals",
    "not",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "notIn",
  ]);
  const clauses: string[] = [];
  // `elem` is each jsonb array element; `txt` reads it (or a nested field) as text.
  const constrain = (txt: string, jsn: string, c: any): void => {
    if (!isFilterObject(c)) {
      clauses.push(`${jsn} = to_jsonb(${P(c)}::${pgType(c)})`);
      return;
    }
    const rec = c as Record<string, any>;
    for (const op of Object.keys(rec)) {
      const v = rec[op];
      if (v === undefined || op === "mode") continue;
      if (op === "equals") clauses.push(`${jsn} = to_jsonb(${P(v)}::${pgType(v)})`);
      else if (op === "not")
        clauses.push(
          v === null
            ? `(${jsn} IS NOT NULL AND ${jsn} <> 'null'::jsonb)`
            : `(${jsn} IS NULL OR ${jsn} <> to_jsonb(${P(v)}::${pgType(v)}))`,
        );
      else if (op === "in")
        clauses.push(
          Array.isArray(v) && v.length
            ? `${jsn} IN (${v.map((x: any) => `to_jsonb(${P(x)}::${pgType(x)})`).join(", ")})`
            : "false",
        );
      else if (op === "notIn")
        clauses.push(
          Array.isArray(v) && v.length
            ? `(${jsn} IS NULL OR ${jsn} NOT IN (${v.map((x: any) => `to_jsonb(${P(x)}::${pgType(x)})`).join(", ")}))`
            : "true",
        );
      else if (PG_CMP[op])
        clauses.push(
          typeof v === "number"
            ? `(${txt})::numeric ${PG_CMP[op]} ${P(v)}`
            : `${txt} ${PG_CMP[op]} ${P(v)}`,
        );
      else
        throw new MonliteQueryError(
          `Unsupported elemMatch operator "${op}" (postgres)`,
        );
    }
  };
  const scalarForm =
    !isFilterObject(sub) ||
    Object.keys(sub).every((k) => SCALAR.has(k) || k === "mode");
  if (scalarForm) {
    constrain("elem#>>'{}'", "elem", sub);
  } else {
    const rec = sub as Record<string, any>;
    for (const k of Object.keys(rec)) {
      const kk = k.replace(/'/g, "''");
      constrain(`elem->>'${kk}'`, `elem->'${kk}'`, rec[k]);
    }
  }
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(${arrayJsn}) elem WHERE ${clauses.join(" AND ")})`;
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
