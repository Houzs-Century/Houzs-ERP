// One-shot sweep: recompute stock allocation for migrated 2990 Sales Orders.
//
// WHY (owner handoff, 2026-07-24): 2990-source SOs (company_id = 2) were
// imported directly into the DB, bypassing the app's create/mutate paths that
// normally fire `recomputeSoStockAllocation`. So their line-level allocation
// (stock_status + stock_qty_ready) was never computed and the SO grid shows
// blank Stock columns. This runs the CANONICAL recompute so those columns light
// up - the same operation every GRN / DO / return already triggers in prod.
//
// REUSE, NOT REPLICATION. APPLY calls the real `recomputeSoStockAllocation`
// from backend/src/scm/lib/so-stock-allocation.ts unchanged - the identical
// FIFO / per-warehouse / sofa-batch-coverage / partial-fill algorithm the live
// system uses. That function is pure supabase-js (PostgREST) with no Cloudflare
// Worker dependency, so it runs verbatim in Node under `tsx`. We deliberately
// do NOT re-implement the allocation here: a subtly-different sweep is worse
// than none (see task constraint + so-stock-allocation.ts header).
//
// The real function has NO dry-run mode - it writes inline. So:
//   DRY-RUN (default): READ-ONLY. Enumerate the company-2 allocatable SOs and
//     report how many lines currently have un-computed allocation
//     (stock_qty_ready IS NULL) and the current stock_status breakdown, so the
//     owner sees the blast radius before writing. It does NOT fabricate exact
//     target numbers - that would mean replicating the allocation.
//   APPLY (APPLY=1 or --apply): runs the canonical global recompute ONCE, then
//     re-reads the company-2 set and reports the ACTUAL resulting stock_status
//     + stock_qty_ready from the authoritative function, plus its own counts.
//
// APPLY runs the GLOBAL recompute (no company filter - the function is global
// by design; older orders claim shared stock first). It is idempotent and only
// writes lines whose (status, qty) actually change, so companies already
// correctly allocated are a no-op; a re-run after success writes nothing new.
//
// Access path: the real function talks to Supabase via PostgREST, so this needs
// the REST creds (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, schema `scm`) - NOT
// the pg DATABASE_URL the delivered-DO backfill used. Same database, the other
// access path (see backend/src/db/supabase.ts).
//
// Run: npx tsx scripts/recompute-2990-so-allocation.mjs           (DRY-RUN)
//      APPLY=1 npx tsx scripts/recompute-2990-so-allocation.mjs   (writes)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { recomputeSoStockAllocation } from "../src/scm/lib/so-stock-allocation.ts";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const APPLY = process.env.APPLY === "1" || process.argv.includes("--apply");
const COMPANY_2990 = 2;

// THE terminal set the recompute itself excludes, imported rather than
// restated - so-stock-allocation.ts now reads the same constant. A snapshot
// taken through a different lens than the function it is checking is not a
// narrower answer, it is a wrong one.
const NON_ALLOCATABLE = SO_TERMINAL_STATES;

// Resolve one field from .dev.vars for local runs WITHOUT printing the value
// (repo secret-safety rule: match the field, never echo the raw line). CI passes
// these as env, so this branch is local-only.
function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const SUPABASE_URL = process.env.SUPABASE_URL || fromDevVars("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fromDevVars("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the Houzs Supabase REST creds). " +
      "These are Worker secrets; add them as GitHub Actions secrets to run this workflow.",
  );
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// Build the SAME client the Worker's getSupabaseService() builds: service role,
// default schema `scm` so the function's sb.from('mfg_sales_orders') resolves to
// scm.mfg_sales_orders unchanged.
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "scm" },
  auth: { persistSession: false, autoRefreshToken: false },
});

// Page past PostgREST's 1000-row cap (same reason the function paginates).
async function pageAll(build) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// Batch an .in() over a big id list AND page each batch.
async function chunkPageIn(values, build) {
  const IN_BATCH = 200;
  const out = [];
  for (let i = 0; i < values.length; i += IN_BATCH) {
    const batch = values.slice(i, i + IN_BATCH);
    out.push(...(await pageAll((from, to) => build(batch, from, to))));
  }
  return out;
}

async function loadCompany2Items() {
  const orders = await pageAll((from, to) =>
    sb
      .from("mfg_sales_orders")
      .select("doc_no, status")
      .eq("company_id", COMPANY_2990)
      .not("status", "in", `(${NON_ALLOCATABLE.join(",")})`)
      .order("doc_no")
      .range(from, to),
  );
  const docNos = orders.map((o) => o.doc_no);
  const items =
    docNos.length === 0
      ? []
      : await chunkPageIn(docNos, (batch, from, to) =>
          sb
            .from("mfg_sales_order_items")
            .select("id, doc_no, item_code, stock_status, stock_qty_ready, cancelled")
            .in("doc_no", batch)
            .eq("cancelled", false)
            .range(from, to),
        );
  return { orders, items };
}

function summarise(items) {
  const uncomputed = items.filter((i) => i.stock_qty_ready === null || i.stock_qty_ready === undefined);
  const byStatus = new Map();
  for (const i of items) {
    const k = i.stock_status ?? "(null)";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  const uncomputedDocs = new Set(uncomputed.map((i) => i.doc_no));
  return { uncomputed, byStatus, uncomputedDocs };
}

try {
  notice(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company_id=${COMPANY_2990}`);

  const before = await loadCompany2Items();
  const b = summarise(before.items);
  notice(
    `company-${COMPANY_2990} allocatable SOs: ${before.orders.length}, non-cancelled lines: ${before.items.length}`,
  );
  notice(
    `lines with un-computed allocation (stock_qty_ready IS NULL): ${b.uncomputed.length} across ${b.uncomputedDocs.size} SO(s)`,
  );
  notice(
    `current stock_status breakdown: ${[...b.byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  );
  // List the affected SOs so the run log is a record of what will be swept.
  const perDoc = new Map();
  for (const i of b.uncomputed) perDoc.set(i.doc_no, (perDoc.get(i.doc_no) ?? 0) + 1);
  for (const [doc, n] of [...perDoc.entries()].sort()) {
    notice(`  ${doc}: ${n} un-computed line(s)`);
  }

  if (!APPLY) {
    notice(
      "DRY-RUN - nothing written. APPLY will run recomputeSoStockAllocation (canonical global " +
        "recompute) and report the actual resulting stock_status / stock_qty_ready. Set APPLY=1 to write.",
    );
    process.exit(0);
  }

  notice("APPLY - running recomputeSoStockAllocation(sb) [canonical global recompute, idempotent]...");
  const result = await recomputeSoStockAllocation(sb);
  if (!result.ok) {
    // A genuine write failure (broken lock, missing column, unreachable DB). Red
    // the job so the owner notices - this is a WRITE tool, not a read-only check.
    console.error(`recompute failed: ${result.reason ?? "ok=false"}`);
    process.exit(1);
  }
  notice(
    `recompute ok: linesFlipped=${result.linesFlipped}, ordersAdvanced=${result.ordersAdvanced}, ` +
      `ordersRegressed=${result.ordersRegressed}` +
      (result.reason ? `, note=${result.reason}` : "") +
      (result.deferredDocNos?.length ? `, deferredHeaders=${result.deferredDocNos.length}` : ""),
  );

  // Re-read the company-2 set to report the ACTUAL post-recompute state from the
  // authoritative function (not a re-derived guess).
  const after = await loadCompany2Items();
  const a = summarise(after.items);
  notice(
    `AFTER: company-${COMPANY_2990} lines still un-computed (stock_qty_ready IS NULL): ${a.uncomputed.length} ` +
      `across ${a.uncomputedDocs.size} SO(s)`,
  );
  notice(
    `AFTER stock_status breakdown: ${[...a.byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  );
  // A line can legitimately remain PENDING with stock_qty_ready written to 0
  // (no stock). It only stays NULL if the recompute short-circuited an already-
  // equal (status, qty) pair - surface that honestly rather than forcing a write.
  notice("Done. Re-run in DRY-RUN to confirm the sweep is idempotent (0 further changes expected).");
} catch (e) {
  console.error(`recompute-2990-so-allocation failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
