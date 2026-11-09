#!/usr/bin/env node
/* Read-only. Post-deploy proof for two shipped changes (issue #5459), without
 * anyone logging in:
 *
 *   (a) #5398 — the 5-minute health report to the IT Hub. System Health's line
 *       "Health report to IT Hub: Last sent ..." is read from public.job_runs
 *       rows WHERE job = 'health-hub' (routes/systemHealthJobs.ts). TRAP: a run
 *       on a Worker with no hub address/key returns { sent: false } and is STILL
 *       recorded status 'ok' (services/healthHub.ts sendHealthReportToHub), so
 *       an 'ok' row alone does not prove a report left. Duration separates the
 *       two: a not-set-up run does no work, a real one measures the DB and makes
 *       an HTTP call. keepwarm (one SELECT 1) is printed beside it as the floor.
 *       The workflow also lists the Worker's IT_HUB_* secret NAMES.
 *
 *   (b) #5444 — the PO-raised edit lock on Houzs orders. Counts the Houzs SOs a
 *       live (non-CANCELLED) PO claims, using the same chain soPoLocked walks
 *       (scm/lib/so-po-lock.ts). COUNTS ONLY: this repo is public, so no doc
 *       number is printed except HC-SO-2610-075, which the source already names.
 *
 * SELECTs only, no transaction, no writes. Exit 0 for every answer; non-zero
 * only when the database cannot be reached. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const say = (m) => console.log(m);
const TODAY_MY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const TERMINAL = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "CANCELLED"];
const NAMED_DOC = "HC-SO-2610-075";

function httpClass(err) {
  if (!err) return null;
  const m = /HTTP (\d{3})/.exec(err);
  if (m) return `hub answered HTTP ${m[1]}`;
  if (/timeout|abort/i.test(err)) return "timeout";
  return "other error (text withheld: driver/hub messages can name hosts)";
}

async function hubReport() {
  say("\n================ (a) health report to IT Hub (#5398) ================");
  const [s] = await sql`
    SELECT count(*) FILTER (WHERE status = 'ok')::int      AS ok_48h,
           count(*) FILTER (WHERE status = 'error')::int   AS err_48h,
           count(*) FILTER (WHERE status = 'running')::int AS running_48h,
           min(started_at) AS first_48h,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'ok') AS p50_ms,
           min(duration_ms) FILTER (WHERE status = 'ok') AS min_ms,
           max(duration_ms) FILTER (WHERE status = 'ok') AS max_ms,
           count(*) FILTER (WHERE status = 'ok' AND duration_ms < 1000)::int AS fast_ok
      FROM public.job_runs
     WHERE job = 'health-hub' AND started_at > now() - interval '48 hours'`;
  const [all] = await sql`
    SELECT max(started_at) FILTER (WHERE status = 'ok')    AS last_ok,
           max(started_at) FILTER (WHERE status = 'error') AS last_err,
           min(started_at) AS first_ever,
           (SELECT error FROM public.job_runs WHERE job = 'health-hub' AND status = 'error'
             ORDER BY started_at DESC LIMIT 1) AS last_err_text
      FROM public.job_runs WHERE job = 'health-hub'`;
  const [kw] = await sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms, count(*)::int AS n
      FROM public.job_runs
     WHERE job = 'keepwarm' AND status = 'ok' AND started_at > now() - interval '48 hours'`;
  say(`  now (UTC):                         ${new Date().toISOString()}`);
  say(`  first health-hub run ever:         ${all.first_ever?.toISOString?.() ?? "none"}`);
  say(`  last OK run:                       ${all.last_ok?.toISOString?.() ?? "none"}`);
  say(`  last FAILED run:                   ${all.last_err?.toISOString?.() ?? "none"}`);
  say(`  last failure kind:                 ${httpClass(all.last_err_text) ?? "n/a"}`);
  say(`  last 48h: ok=${s.ok_48h} error=${s.err_48h} running=${s.running_48h} (a 5-minute job is ~576 in 48h)`);
  say(`  last 48h ok-run duration ms:       p50=${s.p50_ms ?? "-"} min=${s.min_ms ?? "-"} max=${s.max_ms ?? "-"}; under 1s=${s.fast_ok}`);
  say(`  keepwarm (SELECT 1) p50 ms, 48h:   ${kw.p50_ms ?? "-"} over ${kw.n} runs  <- floor for a run that does no work`);
  const ok = all.last_ok ? Date.parse(all.last_ok) : null;
  const bad = all.last_err ? Date.parse(all.last_err) : null;
  const page =
    bad != null && (ok == null || bad > ok) ? "Last attempt failed ..." :
    ok == null ? "Not sent yet in the last 14 days" : "Last sent ..., every 5 minutes";
  say(`  System Health would show (IF the Worker has the hub address+key): "${page}"`);
}

async function poLock() {
  say("\n================ (b) PO-raised edit lock on Houzs orders (#5444) ================");
  const companies = await sql`SELECT id, code FROM public.companies ORDER BY id`;
  say(`  companies: ${companies.map((c) => `${c.id}=${c.code}`).join(", ")}`);
  const rows = await sql`
    WITH live AS (
      SELECT DISTINCT i.doc_no
        FROM scm.mfg_sales_order_items i
        JOIN scm.purchase_order_items pi ON pi.so_item_id = i.id
        JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
       WHERE upper(coalesce(po.status::text, '')) <> 'CANCELLED')
    SELECT c.code,
           count(*)::int AS live_po_sos,
           count(*) FILTER (WHERE upper(so.status::text) <> ALL(${TERMINAL}))::int AS open_live_po_sos,
           count(*) FILTER (WHERE upper(so.status::text) <> ALL(${TERMINAL})
                              AND (so.processing_date IS NULL OR so.processing_date::text >= ${TODAY_MY})
                              AND upper(so.status::text) NOT IN ('DRAFT'))::int AS po_lock_only
      FROM live JOIN scm.mfg_sales_orders so ON so.doc_no = live.doc_no
      LEFT JOIN public.companies c ON c.id = so.company_id
     GROUP BY c.code ORDER BY c.code`;
  for (const r of rows) {
    say(`  company ${r.code}: SOs with a live PO=${r.live_po_sos}; still open=${r.open_live_po_sos}; ` +
        `open AND locked only by the PO rule (no passed Processing Date)=${r.po_lock_only}`);
  }
  say(`  "po_lock_only" is the population #5444 changed: before it these Houzs orders took a direct line edit.`);
  const [named] = await sql`
    SELECT so.status::text AS status,
           EXISTS (SELECT 1 FROM scm.mfg_sales_order_items i
                     JOIN scm.purchase_order_items pi ON pi.so_item_id = i.id
                     JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
                    WHERE i.doc_no = so.doc_no AND upper(coalesce(po.status::text, '')) <> 'CANCELLED') AS live_po
      FROM scm.mfg_sales_orders so WHERE so.doc_no = ${NAMED_DOC}`;
  say(`  ${NAMED_DOC} (named in so-po-lock.ts): ${named ? `status=${named.status} live_po=${named.live_po}` : "not found"}`);
}

try {
  await hubReport();
  await poLock();
} catch (e) {
  console.error(`read failed: ${e?.code ?? ""} ${String(e?.message ?? e).slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
