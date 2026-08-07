// Read-only report: every non-cancelled Sales Order whose header total does
// NOT equal the sum of its non-cancelled lines — the "every ringgit is a line"
// integrity check (owner ruling 2026-08-07: "全部都会有 SKU 的 … 怎么可以走后门呢?").
//
// THE SHAPE THIS HUNTS (proven on 2990-SO-2608-006): an SO whose SVC-DELIVERY*
// lines are gone (deleted or cancelled) while the header delivery_fee_centi
// dual-write snapshot survived. recomputeTotals' legacy line-less fallback then
// folds that orphaned snapshot into the total, so the SO reads subtotal RM0 /
// total RM250 with NO line carrying the 250 — money in the total that no line
// owns. The fix PR closes the live path (recomputeDeliveryFeeCore now
// re-materialises an orphaned header fee as lines); this check finds the
// stragglers, and repair-so-fee-line-integrity.mjs (DRY-RUN gated) heals them.
//
// EVIDENCE, NOT GUESSES: each row carries its audit-log trace — the CREATE
// entry's source/status (scan drafts land source='scan' status DRAFT; the POS /
// desktop / mobile land 'web' CONFIRMED) and every line-audit entry that names
// an SVC-DELIVERY* code — so the output PROVES which route authored the shape
// and which mutation removed the fee line, per SO.
//
// Strictly ONE SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — clean AND dirty are both answers; only an unreachable
// database or a query error exits non-zero. Manual trigger only (see
// .github/workflows/so-fee-line-integrity.yml).
import { readFileSync } from "node:fs";
import postgres from "postgres";

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

// `notice` surfaces the verdict on the workflow run's summary page.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const rm = (centi) => `RM${(Number(centi ?? 0) / 100).toFixed(2)}`;

try {
  /* One statement. Per non-cancelled SO: header total vs Σ(non-cancelled line
     totals), the delivery-fee header snapshot, the SVC-DELIVERY* line
     presence, and the audit-log evidence (CREATE provenance + every line
     mutation that names an SVC-DELIVERY* code). */
  const rows = await pg`
    SELECT so.doc_no,
           so.company_id,
           so.status,
           so.created_at,
           COALESCE(so.local_total_centi, 0) AS local_total_centi,
           COALESCE(l.line_sum, 0)        AS line_sum,
           COALESCE(so.local_total_centi, 0) - COALESCE(l.line_sum, 0) AS diff_centi,
           COALESCE(so.delivery_fee_centi, 0) AS header_fee_centi,
           COALESCE(l.fee_line_count, 0)  AS fee_line_count,
           COALESCE(l.fee_line_sum, 0)    AS fee_line_sum,
           a.create_source,
           a.create_status,
           a.create_actor,
           a.fee_line_audit
      FROM scm.mfg_sales_orders so
      LEFT JOIN LATERAL (
        SELECT SUM(i.total_centi) FILTER (WHERE NOT i.cancelled)                                          AS line_sum,
               SUM(i.total_centi) FILTER (WHERE NOT i.cancelled AND i.item_code LIKE 'SVC-DELIVERY%')      AS fee_line_sum,
               COUNT(*)          FILTER (WHERE NOT i.cancelled AND i.item_code LIKE 'SVC-DELIVERY%')      AS fee_line_count
          FROM scm.mfg_sales_order_items i
         WHERE i.doc_no = so.doc_no
      ) l ON true
      LEFT JOIN LATERAL (
        SELECT MAX(g.source)          FILTER (WHERE g.action = 'CREATE') AS create_source,
               MAX(g.status_snapshot) FILTER (WHERE g.action = 'CREATE') AS create_status,
               MAX(g.actor_name_snapshot) FILTER (WHERE g.action = 'CREATE') AS create_actor,
               jsonb_agg(
                 jsonb_build_object(
                   'at',     g.created_at,
                   'action', g.action,
                   'actor',  g.actor_name_snapshot,
                   'source', g.source,
                   'changes', g.field_changes
                 ) ORDER BY g.created_at
               ) FILTER (WHERE g.action IN ('ADD_LINE', 'UPDATE_LINE', 'DELETE_LINE')
                           AND g.field_changes::text LIKE '%SVC-DELIVERY%')   AS fee_line_audit
          FROM scm.mfg_so_audit_log g
         WHERE g.so_doc_no = so.doc_no
      ) a ON true
     WHERE so.status <> 'CANCELLED'
       AND COALESCE(so.local_total_centi, 0) <> COALESCE(l.line_sum, 0)
     ORDER BY so.created_at DESC`;

  if (rows.length === 0) {
    notice("CLEAN — every non-cancelled SO's total equals the sum of its lines. No header-carried money anywhere.");
  } else {
    let repairable = 0;
    let other = 0;
    for (const r of rows) {
      const diff = Number(r.diff_centi);
      const headerFee = Number(r.header_fee_centi);
      const feeLines = Number(r.fee_line_count);
      /* Repairable = exactly the 006 shape: the WHOLE gap is the orphaned
         header delivery fee and no live SVC-DELIVERY* line exists. Anything
         else is a different corruption class and needs a human. */
      const isRepairable = feeLines === 0 && headerFee > 0 && diff === headerFee;
      if (isRepairable) repairable++; else other++;

      console.log("=".repeat(76));
      console.log(`${r.doc_no}  [${r.status}]  company ${r.company_id}  created ${r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : "?"}`);
      console.log(`  header total ${rm(r.local_total_centi)}  vs  Σ(lines) ${rm(r.line_sum)}  →  diff ${rm(diff)}`);
      console.log(`  header delivery_fee_centi ${rm(headerFee)} · live SVC-DELIVERY* lines: ${feeLines} (Σ ${rm(r.fee_line_sum)})`);
      console.log(`  created via: source=${r.create_source ?? "(no CREATE audit)"} status=${r.create_status ?? "?"} actor=${r.create_actor ?? "?"}`);
      const audit = r.fee_line_audit;
      if (Array.isArray(audit) && audit.length > 0) {
        console.log("  SVC-DELIVERY* line audit trail:");
        for (const e of audit) {
          console.log(`    ${new Date(e.at).toISOString()}  ${e.action}  by ${e.actor ?? "?"} (${e.source ?? "?"})  ${JSON.stringify(e.changes)}`);
        }
      } else {
        console.log("  SVC-DELIVERY* line audit trail: none recorded");
      }
      console.log(
        isRepairable
          ? "  → HEADER-ONLY DELIVERY FEE — repairable: the missing SVC-DELIVERY line equals the header fee (repair-so-fee-line-integrity.mjs)."
          : "  → OTHER MISMATCH — the gap is NOT the header delivery fee (or fee lines exist). Not auto-repairable; investigate before touching.",
      );
    }
    console.log("=".repeat(76));
    notice(
      `${rows.length} SO(s) where total ≠ Σ(lines): ${repairable} header-only delivery fee (repairable via the DRY-RUN gated repair), ${other} other mismatch (investigate).`,
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
