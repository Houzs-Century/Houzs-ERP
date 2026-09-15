// Read-only check of the Purchase Order list exports (GET
// /api/scm/mfg-purchase-orders/export/lines and /export/headers, 2026-09-15).
//
// WHY. The exports must hold EVERY order the list's tab matches, across every
// page. A unit test proves the paging logic against a fake; only the running
// system proves the real PostgREST edge and the real data agree. This compares
// what the DEPLOYED endpoint returns with a direct count of the same rows.
//
// Two halves:
//   1. SQL (always) — per company: purchase orders and their lines for the
//      "open" tab (status SUBMITTED) and for all statuses, plus the facts the
//      export's column rules depend on (the estimate-date line/header split,
//      the money column types).
//   2. API (only when API_URL + E2E credentials are set, i.e. on STAGING) —
//      signs in, calls both exports per company, and prints MATCH / MISMATCH
//      against half 1's counts.
//
// Strictly read-only: the session is set READ ONLY before the first query and
// every statement is a SELECT. Exits 0 for every answer, MISMATCH included — the
// answer is the output. Non-zero only for an unreachable database or API.
//
// RE-RUN: Actions -> "PO line export check (read-only)" -> Run workflow.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* The "open" tab is the SUBMITTED bucket in backend/src/scm/lib/po-status-buckets.ts. */
const OPEN = ["SUBMITTED"];

async function sqlCounts(companyId, statuses) {
  const [po] = statuses
    ? await pg`SELECT count(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${companyId} AND status = ANY(${statuses})`
    : await pg`SELECT count(*)::int AS n FROM scm.purchase_orders WHERE company_id = ${companyId}`;
  const [lines] = statuses
    ? await pg`SELECT count(*)::int AS n FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
               WHERE p.company_id = ${companyId} AND i.company_id = ${companyId} AND p.status = ANY(${statuses})`
    : await pg`SELECT count(*)::int AS n FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
               WHERE p.company_id = ${companyId} AND i.company_id = ${companyId}`;
  return { pos: po.n, lines: lines.n };
}

let failed = false;
try {
  await pg`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  const [{ db }] = await pg`SELECT current_database() AS db`;
  notice(`database: ${db}`);

  const companies = await pg`SELECT id, code FROM public.companies ORDER BY id`;
  const counts = new Map();
  for (const co of companies) {
    const open = await sqlCounts(co.id, OPEN);
    const all = await sqlCounts(co.id, null);
    counts.set(co.id, { open, all });
    notice(`SQL company ${co.id} ${co.code}: open tab ${open.pos} POs / ${open.lines} lines; all ${all.pos} POs / ${all.lines} lines`);
  }

  const types = await pg`
    SELECT column_name, data_type, numeric_scale FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'purchase_order_items'
      AND column_name IN ('qty', 'received_qty', 'unit_price_sen', 'line_total_sen')
    ORDER BY column_name`;
  for (const t of types) notice(`type purchase_order_items.${t.column_name}: ${t.data_type}${t.numeric_scale != null ? ` scale ${t.numeric_scale}` : ""}`);

  for (const slot of [2, 3, 4]) {
    const col = `supplier_delivery_date_${slot}`;
    const [r] = await pg.unsafe(`
      SELECT count(*) FILTER (WHERE i.${col} IS NOT NULL)::int                                   AS line_set,
             count(*) FILTER (WHERE p.${col} IS NOT NULL)::int                                   AS header_set,
             count(*) FILTER (WHERE i.${col} IS NOT NULL AND p.${col} IS NOT NULL
                               AND i.${col} <> p.${col})::int                                    AS both_differ,
             count(*) FILTER (WHERE i.${col} IS NULL AND p.${col} IS NOT NULL)::int              AS header_fills_blank_line
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id`);
    notice(`${col} (Estimate Delivery Date ${slot - 1}) over all lines: line set ${r.line_set}; header set ${r.header_set}; both set and DIFFERENT ${r.both_differ} (the line wins); header fills a blank line ${r.header_fills_blank_line}`);
  }

  const [cross] = await pg`
    SELECT count(*)::int AS n FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE i.company_id <> p.company_id`;
  notice(`lines whose company differs from their PO's (excluded by the line read's company predicate): ${cross.n}`);

  const api = process.env.API_URL;
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!api || !email || !password) {
    notice("API half skipped: API_URL / E2E credentials not set (production has none by design).");
  } else {
    const login = await fetch(`${api}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error(`staging login failed: HTTP ${login.status}`);
    const { token } = await login.json();
    if (!token) throw new Error("staging login returned no token");
    const call = async (path, companyId) => {
      const t0 = Date.now();
      const res = await fetch(`${api}/api/scm/mfg-purchase-orders${path}`, {
        headers: { authorization: `Bearer ${token}`, "x-company-id": String(companyId) },
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* reported below */ }
      return { status: res.status, ms, body, text: text.slice(0, 300) };
    };
    const verdict = (label, got, want) => {
      const ok = got === want;
      if (!ok) failed = true;
      notice(`${ok ? "MATCH" : "MISMATCH"} ${label}: endpoint ${got}, SQL ${want}`);
    };
    for (const co of companies) {
      const want = counts.get(co.id);
      const lines = await call("/export/lines?status=open", co.id);
      if (lines.status !== 200) { failed = true; notice(`company ${co.code} /export/lines?status=open -> HTTP ${lines.status} ${lines.text}`); continue; }
      notice(`company ${co.code} /export/lines?status=open: HTTP 200 in ${lines.ms} ms, truncated=${lines.body.truncated}`);
      verdict(`company ${co.code} open tab POs`, lines.body.poCount, want.open.pos);
      verdict(`company ${co.code} open tab lines`, lines.body.lineCount, want.open.lines);
      verdict(`company ${co.code} open tab rows`, lines.body.rows.length, want.open.lines);

      const allLines = await call("/export/lines", co.id);
      if (allLines.status !== 200) { failed = true; notice(`company ${co.code} /export/lines -> HTTP ${allLines.status} ${allLines.text}`); continue; }
      notice(`company ${co.code} /export/lines (All tab): HTTP 200 in ${allLines.ms} ms, truncated=${allLines.body.truncated}`);
      verdict(`company ${co.code} all POs`, allLines.body.poCount, want.all.pos);
      verdict(`company ${co.code} all lines`, allLines.body.lineCount, want.all.lines);

      const headers = await call("/export/headers?status=open", co.id);
      if (headers.status !== 200) { failed = true; notice(`company ${co.code} /export/headers?status=open -> HTTP ${headers.status} ${headers.text}`); continue; }
      notice(`company ${co.code} /export/headers?status=open: HTTP 200 in ${headers.ms} ms`);
      verdict(`company ${co.code} open tab header rows`, headers.body.total, want.open.pos);
    }
    notice(failed ? "VERDICT: at least one MISMATCH or error above." : "VERDICT: every endpoint count matches the direct SQL count.");
  }
} catch (e) {
  console.error(e?.message ?? e);
  await pg.end({ timeout: 5 });
  process.exit(1);
}
await pg.end({ timeout: 5 });
