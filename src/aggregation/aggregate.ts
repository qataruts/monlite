import type {
  AggregateArgs,
  AggregateResult,
  GroupByArgs,
  GroupByResult,
  HavingComparison,
  HavingInput,
} from "../types.js";
import type { Driver } from "../driver/types.js";
import { MonliteQueryError } from "../errors.js";
import { buildWhere } from "../query/where.js";
import { fieldExpr, isColumn } from "../query/sql.js";

export interface AggContext {
  db: Driver;
  table: string;
  onPath: (path: string) => void;
  /** Declared native columns (structured collections). */
  columns?: Set<string>;
}

const ACCUMULATORS = ["_sum", "_avg", "_min", "_max"] as const;
type Accumulator = (typeof ACCUMULATORS)[number];

const SQL_FN: Record<Accumulator, string> = {
  _sum: "SUM",
  _avg: "AVG",
  _min: "MIN",
  _max: "MAX",
};

interface AccCol {
  alias: string;
  kind: Accumulator;
  field: string;
}

/** Build the accumulator SELECT fragments shared by aggregate and groupBy. */
function buildAccumulators(
  args: { _sum?: any; _avg?: any; _min?: any; _max?: any },
  onPath: (p: string) => void,
  columns?: Set<string>,
): { selects: string[]; cols: AccCol[] } {
  const selects: string[] = [];
  const cols: AccCol[] = [];
  let i = 0;

  for (const kind of ACCUMULATORS) {
    const selection = args[kind];
    if (!selection) continue;
    for (const field of Object.keys(selection)) {
      if (!selection[field]) continue;
      if (!isColumn(field, columns)) onPath(field);
      const alias = `agg_${kind.slice(1)}_${i++}`;
      selects.push(`${SQL_FN[kind]}(${fieldExpr(field, columns)}) AS ${alias}`);
      cols.push({ alias, kind, field });
    }
  }
  return { selects, cols };
}

export function aggregate(
  ctx: AggContext,
  args: AggregateArgs,
): AggregateResult {
  const params: any[] = [];
  const where = buildWhere(args.where, {
    params,
    onPath: ctx.onPath,
    columns: ctx.columns,
  });
  const { selects, cols } = buildAccumulators(args, ctx.onPath, ctx.columns);

  // Always compute count internally; expose only when requested.
  const allSelects = [`COUNT(*) AS agg_count`, ...selects];
  const sql = `SELECT ${allSelects.join(", ")} FROM "${ctx.table}" WHERE ${where}`;
  const row = (ctx.db.prepare(sql).get(...params) ?? {}) as Record<string, any>;

  const result: AggregateResult = {};
  if (args._count) result._count = row.agg_count ?? 0;
  for (const col of cols) {
    const bucket = (result[col.kind] ??= {});
    bucket[col.field] = row[col.alias] ?? null;
  }
  return result;
}

const HAVING_FNS = [
  ["_sum", "SUM"],
  ["_avg", "AVG"],
  ["_min", "MIN"],
  ["_max", "MAX"],
] as const;

function comparisonSql(
  expr: string,
  cmp: HavingComparison,
  params: any[],
): string[] {
  const out: string[] = [];
  const ops: Array<[keyof HavingComparison, string]> = [
    ["equals", "="],
    ["not", "<>"],
    ["gt", ">"],
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
  ];
  for (const [key, op] of ops) {
    const v = cmp[key];
    if (v === undefined) continue;
    params.push(v);
    out.push(`${expr} ${op} ?`);
  }
  return out;
}

/** Build a SQL `HAVING` expression from a having spec. Returns "" when empty. */
function buildHaving(
  having: HavingInput,
  params: any[],
  columns?: Set<string>,
): string {
  const parts: string[] = [];
  if (having._count) {
    parts.push(...comparisonSql("COUNT(*)", having._count, params));
  }
  for (const [kind, fn] of HAVING_FNS) {
    const selection = having[kind];
    if (!selection) continue;
    for (const field of Object.keys(selection)) {
      parts.push(
        ...comparisonSql(
          `${fn}(${fieldExpr(field, columns)})`,
          selection[field]!,
          params,
        ),
      );
    }
  }
  return parts.join(" AND ");
}

export function groupBy(ctx: AggContext, args: GroupByArgs): GroupByResult[] {
  if (!Array.isArray(args.by) || args.by.length === 0) {
    throw new MonliteQueryError("groupBy requires a non-empty `by` array");
  }

  const params: any[] = [];
  const where = buildWhere(args.where, {
    params,
    onPath: ctx.onPath,
    columns: ctx.columns,
  });

  // Use generated aliases (never the raw field name) so a user-supplied `by`
  // field can never break out of the SQL — then map back to the field in JS.
  const groupExprs: string[] = [];
  const groupCols: Array<{ alias: string; field: string }> = [];
  const selects: string[] = [];
  args.by.forEach((field, gi) => {
    if (!isColumn(field, ctx.columns)) ctx.onPath(field);
    const expr = fieldExpr(field, ctx.columns);
    const alias = `grp_${gi}`;
    groupExprs.push(expr);
    selects.push(`${expr} AS ${alias}`);
    groupCols.push({ alias, field });
  });

  selects.push(`COUNT(*) AS agg_count`);
  const { selects: accSelects, cols } = buildAccumulators(
    args,
    ctx.onPath,
    ctx.columns,
  );
  selects.push(...accSelects);

  let sql =
    `SELECT ${selects.join(", ")} FROM "${ctx.table}" WHERE ${where} ` +
    `GROUP BY ${groupExprs.join(", ")}`;

  if (args.having) {
    // HAVING params come after WHERE params and before LIMIT/OFFSET — push now.
    const havingSql = buildHaving(args.having, params, ctx.columns);
    if (havingSql) sql += ` HAVING ${havingSql}`;
  }

  if (args.orderBy) {
    const parts: string[] = [];
    for (const key of Object.keys(args.orderBy)) {
      const val = (args.orderBy as Record<string, any>)[key];
      if (key === "_count") {
        const dir = String(val).toLowerCase() === "desc" ? "DESC" : "ASC";
        parts.push(`agg_count ${dir}`);
      } else if (
        (ACCUMULATORS as readonly string[]).includes(key) &&
        val &&
        typeof val === "object"
      ) {
        // orderBy by an accumulator — e.g. `{ _sum: { total: "desc" } }`.
        for (const field of Object.keys(val)) {
          const dir =
            String(val[field]).toLowerCase() === "desc" ? "DESC" : "ASC";
          if (!isColumn(field, ctx.columns)) ctx.onPath(field);
          parts.push(
            `${SQL_FN[key as Accumulator]}(${fieldExpr(field, ctx.columns)}) ${dir}`,
          );
        }
      } else {
        const dir = String(val).toLowerCase() === "desc" ? "DESC" : "ASC";
        parts.push(`${fieldExpr(key, ctx.columns)} ${dir}`);
      }
    }
    if (parts.length) sql += ` ORDER BY ${parts.join(", ")}`;
  }

  if (args.take != null) {
    sql += " LIMIT ?";
    params.push(args.take);
  }
  if (args.skip != null) {
    sql += (args.take != null ? "" : " LIMIT -1") + " OFFSET ?";
    params.push(args.skip);
  }

  const rows = ctx.db.prepare(sql).all(...params) as Array<Record<string, any>>;

  return rows.map((row) => {
    const out: GroupByResult = {};
    for (const { alias, field } of groupCols) out[field] = row[alias];
    if (args._count) out._count = row.agg_count;
    for (const col of cols) {
      (out[col.kind] ??= {})[col.field] = row[col.alias] ?? null;
    }
    return out;
  });
}
