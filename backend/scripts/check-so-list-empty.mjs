// Read-only probe for the 2026-08-18 "Sales Orders list shows ZERO orders"
// incident. The SO list endpoint (GET /api/scm/mfg-sales-orders) reads the VIEW
// scm.mfg_sales_orders_with_payment_totals, filtered by company_id (and, for a
// non-view-all caller, by salesperson_id). It began returning HTTP 500
// "Requested range not satisfiable" — a PostgREST symptom of count(*) === 0 —
// right after the batch that renamed every _centi money column to _sen and
// DROP/CREATEd 11 views (migration 0305, PRs #2438/#2441).
//
// WHAT THIS ANSWERS, with the numbers that pin the cause and nothing else:
//
//   Per company_id:
//     · base  = count(*) FROM scm.mfg_sales_orders                        (the truth)
//     · view  = count(*) FROM scm.mfg_sales_orders_with_payment_totals    (what the list reads)
//     · status distribution (so we can see whether 'all' is ever a real value — it is not)
//
//   If base == view for every company, the recreated view is FAITHFUL and the
//   empty list is a COMPANY-SCOPE / active-company problem, not a view problem.
//   If view < base for a company, the recreate dropped rows and the view is the bug.
//   Either way the answer is in the printed numbers, not in a guess.
//
// Also reports whether the view still EXPOSES company_id / salesperson_id at all
// (a recreate that dropped a filtered column would make the route's .eq()/.in()
// error), and the salesperson_id null-rate on the base table.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — a red job would read as "the check broke", and the whole
// point is that the ANSWER is the output. Only an unreachable DB or a query
// error exits non-zero. Manual dispatch only, own concurrency group.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const VIEW = "scm.mfg_sales_orders_with_payment_totals";
const BASE = "scm.mfg_sales_orders";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

// `notice` surfaces the verdict on the workflow run's summary page, so the
// answer is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // 1) Does the view still exist and expose the columns the route filters on?
  const cols = await pg`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'scm'
       AND table_name = 'mfg_sales_orders_with_payment_totals'
       AND column_name IN ('company_id', 'salesperson_id', 'status',
                           'paid_total_sen', 'balance_sen_live')
     ORDER BY column_name`;
  const present = cols.map((r) => r.column_name);
  notice(`view exposes: ${present.length ? present.join(", ") : "(view MISSING or has none of the filtered columns)"}`);

  // 2) The companies master, so a reader can map id -> code.
  const companies = await pg`
    SELECT id, code, name, is_active FROM public.companies ORDER BY id`;
  for (const co of companies) {
    notice(`company ${co.id} = ${co.code} (${co.name}) is_active=${co.is_active}`);
  }

  // 3) THE HEART: base vs view count per company_id. Separate one-statement
  //    SELECTs; a LEFT JOIN so a company present in one and not the other still
  //    shows. COALESCE keeps the 0s visible.
  const baseByCo = await pg`
    SELECT company_id, count(*)::int AS n
      FROM scm.mfg_sales_orders
     GROUP BY company_id ORDER BY company_id`;
  const viewByCo = await pg`
    SELECT company_id, count(*)::int AS n
      FROM scm.mfg_sales_orders_with_payment_totals
     GROUP BY company_id ORDER BY company_id`;
  const baseMap = new Map(baseByCo.map((r) => [String(r.company_id), r.n]));
  const viewMap = new Map(viewByCo.map((r) => [String(r.company_id), r.n]));
  const allCo = new Set([...baseMap.keys(), ...viewMap.keys()]);
  notice("---- base vs view count, per company_id ----");
  for (const cid of [...allCo].sort()) {
    const b = baseMap.get(cid) ?? 0;
    const v = viewMap.get(cid) ?? 0;
    const flag = b === v ? "OK (view faithful)" : `MISMATCH (view lost ${b - v} rows)`;
    notice(`company_id=${cid}: base=${b} view=${v} -> ${flag}`);
  }

  // 4) Grand totals — the "thousands exist" claim, proven or refuted.
  const [{ n: baseTotal }] = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders`;
  const [{ n: viewTotal }] = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders_with_payment_totals`;
  notice(`GRAND TOTAL: base=${baseTotal} view=${viewTotal}`);

  // 5) Distinct status values on the base table (is 'all'/'ALL' ever a real
  //    stored status? The route does q.eq('status', status) with the raw query
  //    param, so a literal ?status=all would filter to nothing).
  const statuses = await pg`
    SELECT COALESCE(status::text, '(null)') AS status, count(*)::int AS n
      FROM scm.mfg_sales_orders
     GROUP BY status ORDER BY n DESC`;
  notice("---- distinct status values (base table) ----");
  for (const s of statuses) notice(`status='${s.status}': ${s.n}`);
  const hasAllLiteral = statuses.some((s) => String(s.status).toLowerCase() === "all");
  notice(`status literal 'all' present as a real value? ${hasAllLiteral ? "YES (unexpected)" : "NO — so ?status=all matches zero rows"}`);

  // 6) salesperson_id null-rate on base, PER company — a null salesperson would
  //    be invisible to any non-view-all caller (scoped by .in('salesperson_id', ...)).
  const spByCo = await pg`
    SELECT company_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE salesperson_id IS NULL)::int AS nulls
      FROM scm.mfg_sales_orders
     GROUP BY company_id ORDER BY company_id`;
  notice("---- salesperson_id null-rate, per company_id ----");
  for (const r of spByCo) notice(`company_id=${r.company_id}: salesperson_id null ${r.nulls} of ${r.total}`);

  // 7) THE APP'S EXACT FILTERS, reproduced in raw SQL on the VIEW. The list page
  //    reads the view with .eq('company_id', <active>) and, from the frontend,
  //    .eq('status', 'all'). Show what each predicate returns so the "empty
  //    list" is pinned to the exact predicate that zeroes it, not inferred.
  const [{ n: co1 }] = await pg`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders_with_payment_totals WHERE company_id = 1`;
  const [{ n: co1StatusAll }] = await pg`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders_with_payment_totals
     WHERE company_id = 1 AND status::text = 'all'`;
  notice("---- view rows under the app's predicates (company 1) ----");
  notice(`WHERE company_id=1                    -> ${co1}   (what a view-all caller should page)`);
  notice(`WHERE company_id=1 AND status='all'   -> ${co1StatusAll}   (the frontend's literal ?status=all)`);
} finally {
  await pg.end({ timeout: 5 });
}
