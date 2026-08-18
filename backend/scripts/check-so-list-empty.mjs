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

  // 8) THE PostgREST-LAYER TEST. The app reads the view via getSupabaseService
  //    (@supabase/supabase-js -> hosted PostgREST, service_role). The counts
  //    above are what the DATABASE_URL role (superuser-ish, bypasses RLS) sees
  //    directly. What the app sees is what the PostgREST ROLE sees THROUGH the
  //    view — which respects the view's own privileges/security_invoker and any
  //    RLS on the base table. Reproduce that exactly with SET ROLE, so a raw-vs-
  //    PostgREST discrepancy is OBSERVED, not inferred.
  //
  //    Also dump the view's owner + security_invoker + the base table's RLS
  //    posture + the per-role SELECT grant, because those are the levers that
  //    decide the answer and a DROP/CREATE VIEW (migration 0305) can change them.
  const meta = await pg`
    SELECT c.relname,
           pg_get_userbyid(c.relowner) AS owner,
           (SELECT option_value FROM pg_options_to_table(c.reloptions)
             WHERE option_name = 'security_invoker') AS security_invoker,
           has_table_privilege('service_role',  'scm.mfg_sales_orders_with_payment_totals', 'SELECT') AS svc_can_select,
           has_table_privilege('authenticated', 'scm.mfg_sales_orders_with_payment_totals', 'SELECT') AS auth_can_select,
           has_table_privilege('anon',          'scm.mfg_sales_orders_with_payment_totals', 'SELECT') AS anon_can_select
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'scm' AND c.relname = 'mfg_sales_orders_with_payment_totals'`;
  const m = meta[0] ?? {};
  notice("---- recreated view: ownership / security_invoker / SELECT grants ----");
  notice(`owner=${m.owner} security_invoker=${m.security_invoker ?? '(unset -> definer)'} `
    + `SELECT: service_role=${m.svc_can_select} authenticated=${m.auth_can_select} anon=${m.anon_can_select}`);

  const base = await pg`
    SELECT c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
           pg_get_userbyid(c.relowner) AS owner,
           (SELECT count(*)::int FROM pg_policies p
             WHERE p.schemaname = 'scm' AND p.tablename = 'mfg_sales_orders') AS policy_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'scm' AND c.relname = 'mfg_sales_orders'`;
  const b = base[0] ?? {};
  notice(`base mfg_sales_orders: owner=${b.owner} rls_enabled=${b.rls_enabled} rls_forced=${b.rls_forced} policies=${b.policy_count}`);

  notice("---- count(*) FROM view WHERE company_id=1, AS EACH PostgREST role (this is what the app actually sees) ----");
  for (const role of ["service_role", "authenticated", "anon"]) {
    try {
      // SET LOCAL-style: SET ROLE then RESET, no writes, no transaction needed.
      await pg.unsafe(`SET ROLE ${role}`);
      const rows = await pg`SELECT count(*)::int AS n FROM scm.mfg_sales_orders_with_payment_totals WHERE company_id = 1`;
      notice(`AS ${role}: company_id=1 -> ${rows[0].n}`);
    } catch (e) {
      notice(`AS ${role}: ERROR -> ${e.code ?? ""} ${e.message}`);
    } finally {
      await pg.unsafe("RESET ROLE");
    }
  }

  // 9) THE DECISIVE TWO-LAYER TEST. The app does NOT use direct pg — it reads
  //    through HOSTED Supabase PostgREST over HTTP (getSupabaseService =
  //    @supabase/supabase-js -> SUPABASE_URL, db.schema='scm', service_role).
  //    Every count above is the DIRECT-pg answer. Now issue the app's EXACT
  //    request against hosted PostgREST and report what IT returns. Same DB, and
  //    if the two layers disagree the divergence IS the bug (a stale PostgREST
  //    schema cache after 0305 dropped+recreated 11 views + a matview). Read-only:
  //    every REST call is a GET.
  const REST = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!REST || !KEY) {
    notice("PostgREST layer: NOT TESTED (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absent from this run).");
  } else {
    // GET against the scm schema, service_role, exactly like getSupabaseService.
    const restGet = async (path, range) => {
      const headers = {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Accept-Profile": "scm",
        Prefer: "count=exact",
        Range: range,
        "Range-Unit": "items",
      };
      const res = await fetch(`${REST}/rest/v1/${path}`, { method: "GET", headers });
      const cr = res.headers.get("content-range");
      const body = res.ok ? null : (await res.text()).slice(0, 200);
      return { status: res.status, contentRange: cr, body };
    };
    notice("---- HOSTED PostgREST (the app's real path), service_role, scm schema ----");
    // The VIEW the SO list reads, company_id=1, page 0 (Range 0-49) and page 1 (Range 50-99).
    for (const [label, range] of [["page0 (0-49)", "0-49"], ["page1 (50-99)", "50-99"]]) {
      const r = await restGet("mfg_sales_orders_with_payment_totals?select=doc_no&company_id=eq.1&order=so_date.desc", range);
      notice(`VIEW company_id=1 ${label}: HTTP ${r.status} content-range=${r.contentRange ?? "(none)"}${r.body ? " body=" + r.body : ""}`);
    }
    // Isolate view vs base AT THE PostgREST LAYER: does PostgREST see the BASE
    // table's 2726 while the VIEW returns 0? That pins the stale entry to the
    // recreated view specifically.
    const baseR = await restGet("mfg_sales_orders?select=doc_no&company_id=eq.1", "0-0");
    notice(`BASE mfg_sales_orders company_id=1 (0-0): HTTP ${baseR.status} content-range=${baseR.contentRange ?? "(none)"}${baseR.body ? " body=" + baseR.body : ""}`);
    notice("Direct-pg said view company_id=1 = 2726. If PostgREST's content-range total here is 0/absent, the divergence is the hosted-PostgREST schema cache.");
  }

  // 10) WHY IT PERSISTED. Supabase auto-reloads PostgREST's schema cache on DDL
  //     via event triggers that NOTIFY pgrst. If they are missing/disabled, a
  //     DROP+CREATE VIEW leaves the cache stale until a manual reload.
  const evt = await pg`
    SELECT evtname, evtevent,
           CASE evtenabled WHEN 'O' THEN 'enabled' WHEN 'D' THEN 'DISABLED'
                           WHEN 'R' THEN 'replica' WHEN 'A' THEN 'always' END AS state,
           evtfoid::regprocedure::text AS fn
      FROM pg_event_trigger
     WHERE evtname ILIKE 'pgrst%' OR evtfoid::regprocedure::text ILIKE '%pgrst%'
     ORDER BY evtname`;
  notice("---- PostgREST DDL-watch event triggers (auto-reload on DDL) ----");
  if (evt.length === 0) notice("NONE — no pgrst DDL-watch event trigger exists, so a DROP/CREATE VIEW does NOT auto-reload PostgREST's cache. This is why the outage did not self-heal.");
  else for (const e of evt) notice(`${e.evtname} on ${e.evtevent} -> ${e.fn} [${e.state}]`);

} finally {
  await pg.end({ timeout: 5 });
}
