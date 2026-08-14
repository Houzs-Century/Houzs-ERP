// ---------------------------------------------------------------------------
// repair-so-fee-line-integrity.mjs — materialise the SVC-DELIVERY line a
// header-carried delivery fee lost.
//
// THE SHAPE (proven on 2990-SO-2608-006; owner ruling 2026-08-07: every ringgit
// on a Sales Order is a LINE — "怎么可以走后门呢?"): an SO whose SVC-DELIVERY*
// lines are gone while the header delivery_fee_centi dual-write snapshot
// survived. recomputeTotals' legacy line-less fallback folds that snapshot into
// the total, so the SO reads subtotal RM0 / total RM250 with NO line carrying
// the 250. The fix PR closes the live path; this repair heals the rows already
// in that state.
//
// THE REPAIR, per SO — total is NEVER changed, only ITEMISED:
//   1. re-verify the shape inside the transaction (never from a plan):
//      non-cancelled SO, delivery_fee_centi > 0, ZERO non-cancelled
//      SVC-DELIVERY* lines, and (header total − Σ lines) == delivery_fee_centi
//      EXACTLY — the whole gap is the orphaned fee, nothing else;
//   2. call scm.rebuild_mfg_so_delivery_lines (migration 0214) — the SAME
//      atomic RPC every live derivation uses (advisory per-doc lock,
//      delete → insert → header stamp; company_id read from the SO header).
//      NEVER a hand-written INSERT into mfg_sales_order_items: the RPC is the
//      one write path for SVC-DELIVERY* lines, here as everywhere.
//      The row mirrors recomputeDeliveryFeeCore's build (mfg-sales-orders.ts)
//      field-for-field; its AMOUNT mirrors the header snapshot — the repair
//      itemises the money already in the total, it never re-prices (the next
//      edit re-derives through the fixed core, which owns amounts from then on).
//      cross_category_source_doc_no is passed THROUGH unchanged, so a stored
//      follow-up link is never dropped — and when one exists the line is
//      SVC-DELIVERY-CROSS with the follow-up remark, exactly as
//      buildDeliveryFeeServiceLines would emit it.
//   3. re-roll the two header columns the new line moves (service_centi,
//      line_count) and VERIFY: new Σ(lines) == header total (unchanged), and
//      exactly one live SVC-DELIVERY* line equal to the header fee;
//   4. write one mfg_so_audit_log ADD_LINE row (source 'repair') so the SO's
//      own timeline records the materialisation.
//
// WHAT THIS REFUSES, and why:
//   - gap != header fee            -> the mismatch is NOT the orphaned delivery
//                                     fee; a different corruption class
//   - live SVC-DELIVERY* lines     -> the fee IS itemised; the mismatch is
//                                     something else
//   - CANCELLED SO / fee <= 0      -> nothing to materialise
//   - post-repair verify fails     -> rolled back, listed, left alone
//
// DRY-RUN BY DEFAULT. Each SO is repaired inside a transaction, verified, and
// ROLLED BACK unless APPLY=true AND the confirmation phrase matches. Same
// posture as repair-orphan-do-movements.mjs / repair-phantom-lots.mjs.
//
//   APPLY=true CONFIRM="I HAVE REVIEWED THE DRY-RUN" node backend/scripts/repair-so-fee-line-integrity.mjs
//
// After an APPLY: re-run "SO fee-line integrity check (read-only)" — it should
// report CLEAN (or only the refused rows, which need a human).
//
// NO `#!/usr/bin/env node` line here, deliberately (the other scripts carry one):
// tests/soFeeLineRepairRow.test.ts imports buildFeeLineRow/dateOnly from this
// module, and on Windows vitest INLINES it — the source is wrapped in a function
// before vm.runInThisContext, so a `#!` that is no longer at byte 0 is a hard
// "SyntaxError: Invalid or unexpected token" and the suite fails to load (Linux CI
// externalizes the same file, where node strips the shebang itself — which is why
// this was green on CI and red locally). Every caller runs it as
// `node backend/scripts/...`, so the shebang bought nothing. Don't re-add it.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

/** Business date in Malaysia time, YYYY-MM-DD — same value todayMyt() stamps. */
export function todayMyt() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Normalize a value read from a DATE column to the plain YYYY-MM-DD string the
   row JSON must carry. postgres.js parses date/timestamp oids (1082/1114/1184)
   into JS Date objects; letting a Date ride into JSON.stringify would embed a
   full UTC timestamp in a date field — survivable for Postgres' cast, but a
   record fed to jsonb_populate_recordset should carry exactly the shapes the
   columns hold. */
export function dateOnly(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/**
 * PURE row builder for the 0214 RPC's p_rows — mirrors
 * recomputeDeliveryFeeCore's build (mfg-sales-orders.ts) field-for-field, so a
 * repaired line is indistinguishable from a derived one. company_id is NOT
 * included: the RPC reads it off the SO header (mig 0214). Every value is a
 * JSON-native scalar or null — no Date, no undefined, no NaN — because this
 * object is fed verbatim to jsonb_populate_recordset(NULL::mfg_sales_order_items).
 * Unit-tested in backend/tests/soFeeLineRepairRow.test.ts.
 */
export function buildFeeLineRow({
  docNo,
  debtorName,
  venue,
  customerDeliveryDate,
  crossCategorySourceDocNo,
  feeCenti,
  keptMaxLineNo,
  lineDate,
}) {
  const fee = Number(feeCenti);
  if (!Number.isFinite(fee) || fee <= 0) {
    throw new Error(`buildFeeLineRow: fee must be a positive finite number, got ${feeCenti}`);
  }
  const src = crossCategorySourceDocNo ?? null;
  const isCross = !!src;
  const keptMax = keptMaxLineNo == null ? null : Number(keptMaxLineNo);
  return {
    doc_no: docNo,
    line_no: keptMax == null ? null : keptMax + 1,
    line_date: lineDate ?? todayMyt(),
    debtor_name: debtorName ?? null,
    item_group: "service",
    item_code: isCross ? "SVC-DELIVERY-CROSS" : "SVC-DELIVERY",
    description: isCross ? "Cross-category delivery" : "Delivery fee",
    description2: null,
    remark: isCross ? `Follow-up of ${src}` : null,
    uom: "UNIT",
    qty: 1,
    unit_price_centi: fee,
    discount_centi: 0,
    total_centi: fee,
    total_inc_centi: fee,
    balance_centi: fee,
    variants: null,
    unit_cost_centi: 0,
    line_cost_centi: 0,
    line_margin_centi: fee,
    divan_price_sen: 0,
    leg_price_sen: 0,
    special_order_price_sen: 0,
    custom_specials: null,
    line_delivery_date: dateOnly(customerDeliveryDate),
    line_delivery_date_overridden: false,
    warehouse_id: null,
    branding: null,
    venue: venue ?? null,
    stock_status: "READY",
  };
}

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const rm = (centi) => `RM${(Number(centi ?? 0) / 100).toFixed(2)}`;
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

/** Thrown to force a rollback after a successful dry-run. Not an error. */
class DryRunRollback extends Error {}

async function main() {
  const url = resolveUrl();
  if (!url) {
    console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
    process.exit(1);
  }

  const APPLY = process.env.APPLY === "true" && process.env.CONFIRM === CONFIRM_PHRASE;
  if (process.env.APPLY === "true" && !APPLY) {
    console.log(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}" — running DRY-RUN instead.\n`);
  }

  const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
  let repaired = 0;
  let refused = 0;

  try {
    console.log(`\nSO FEE-LINE INTEGRITY REPAIR — ${APPLY ? "APPLY (writes will be COMMITTED)" : "DRY-RUN (nothing will be written)"}\n`);

    /* Candidate discovery — the exact repairable class the check script reports.
       Re-verified row by row inside each transaction below; this list only
       decides what to LOOK at. */
    const candidates = await pg`
      SELECT so.doc_no
        FROM scm.mfg_sales_orders so
        LEFT JOIN LATERAL (
          SELECT SUM(i.total_centi) FILTER (WHERE NOT i.cancelled)                                     AS line_sum,
                 COUNT(*)          FILTER (WHERE NOT i.cancelled AND i.item_code LIKE 'SVC-DELIVERY%') AS fee_line_count
            FROM scm.mfg_sales_order_items i
           WHERE i.doc_no = so.doc_no
        ) l ON true
       WHERE so.status <> 'CANCELLED'
         AND COALESCE(so.delivery_fee_centi, 0) > 0
         AND COALESCE(l.fee_line_count, 0) = 0
         AND so.local_total_centi - COALESCE(l.line_sum, 0) = COALESCE(so.delivery_fee_centi, 0)
       ORDER BY so.doc_no`;

    if (candidates.length === 0) {
      console.log("No SO carries a header-only delivery fee (every fee is already a line). Nothing to repair.");
      return;
    }

    console.log(`${candidates.length} candidate SO(s):\n`);

    for (const cand of candidates) {
      console.log("=".repeat(76));
      try {
        await pg.begin(async (sql) => {
          const stop = (why) => {
            console.log(`  REFUSED — ${why}`);
            refused++;
            throw new DryRunRollback("refused");
          };

          // Lock the header; everything below is verified against THIS snapshot.
          const [so] = await sql`
            SELECT doc_no, company_id, status, debtor_name, venue,
                   customer_delivery_date, cross_category_source_doc_no,
                   COALESCE(delivery_fee_centi, 0) AS fee_centi,
                   local_total_centi,
                   COALESCE(service_centi, 0) AS service_centi
              FROM scm.mfg_sales_orders
             WHERE doc_no = ${cand.doc_no}
               FOR UPDATE`;
          if (!so) return stop("SO vanished between discovery and repair");
          if (so.status === "CANCELLED") return stop("SO is CANCELLED");
          const fee = Number(so.fee_centi);
          if (fee <= 0) return stop("header delivery fee is no longer > 0");

          const [agg] = await sql`
            SELECT COALESCE(SUM(total_centi) FILTER (WHERE NOT cancelled), 0)                                     AS line_sum,
                   COUNT(*) FILTER (WHERE NOT cancelled AND item_code LIKE 'SVC-DELIVERY%')                       AS fee_line_count,
                   COUNT(*) FILTER (WHERE NOT cancelled)                                                          AS live_line_count,
                   MAX(line_no) FILTER (WHERE item_code NOT LIKE 'SVC-DELIVERY%')                                 AS kept_max_line_no
              FROM scm.mfg_sales_order_items
             WHERE doc_no = ${cand.doc_no}`;
          if (Number(agg.fee_line_count) > 0) return stop("live SVC-DELIVERY* line(s) exist — the fee is already itemised");
          const gap = Number(so.local_total_centi) - Number(agg.line_sum);
          if (gap !== fee) return stop(`gap ${rm(gap)} != header fee ${rm(fee)} — a different mismatch class`);

          const src = so.cross_category_source_doc_no;
          const row = buildFeeLineRow({
            docNo: so.doc_no,
            debtorName: so.debtor_name,
            venue: so.venue,
            customerDeliveryDate: so.customer_delivery_date,
            crossCategorySourceDocNo: src,
            feeCenti: fee,
            keptMaxLineNo: agg.kept_max_line_no,
            lineDate: todayMyt(),
          });
          console.log(`${so.doc_no}  header fee ${rm(fee)}  →  materialise ${row.item_code} qty 1 ${rm(fee)}${src ? ` (follow-up of ${src})` : ""}`);

          /* THE one write path for SVC-DELIVERY* lines — the same 0214 RPC every
             live derivation calls. Passing the stored source + the SAME fee means
             the header stamp is a no-op re-write of what it already says.

             sql.json(), NOT JSON.stringify() (the pg-supabase-transaction.ts
             lesson, owner-reported 2026-07-29 SO-2606-049, re-proven by THIS
             script's first prod dry-run, workflow run 31197887561): binding a
             pre-stringified string to a jsonb parameter double-serializes it —
             postgres.js's describe phase discovers the jsonb OID and runs its
             OWN serializer over the string, so the RPC received the jsonb
             STRING "[{...}]" and jsonb_populate_recordset threw
             "cannot call jsonb_populate_recordset on a non-array".
             sql.json sends the raw value once; the ::jsonb cast keeps function
             resolution exact, mirroring the shim's $4::jsonb. */
          await sql`SELECT scm.rebuild_mfg_so_delivery_lines(
            ${so.doc_no}, ${src}, ${fee}, ${sql.json([row])}::jsonb)`;

          /* The two roll-up columns the new line moves. The smallest honest
             delta: the fee line joins the SERVICE bucket (cost 0), and the line
             count grows by the inserted rows. Every other totals column is
             unchanged BY CONSTRUCTION (the repair adds a line equal to money the
             total already carried); the next edit's recomputeTotals re-rolls the
             whole header through the authoritative TS path anyway. */
          await sql`
            UPDATE scm.mfg_sales_orders
               SET service_centi = ${Number(so.service_centi) + fee},
                   line_count    = (SELECT COUNT(*) FROM scm.mfg_sales_order_items
                                     WHERE doc_no = ${so.doc_no} AND NOT cancelled),
                   updated_at    = now()
             WHERE doc_no = ${so.doc_no}`;

          // VERIFY — total unchanged and now equal to Σ(lines); exactly one live
          // fee line carrying exactly the header fee.
          const [after] = await sql`
            SELECT so2.local_total_centi,
                   COALESCE(so2.delivery_fee_centi, 0) AS fee_centi,
                   (SELECT COALESCE(SUM(i.total_centi) FILTER (WHERE NOT i.cancelled), 0)
                      FROM scm.mfg_sales_order_items i WHERE i.doc_no = so2.doc_no)       AS line_sum,
                   (SELECT COUNT(*) FROM scm.mfg_sales_order_items i
                     WHERE i.doc_no = so2.doc_no AND NOT i.cancelled
                       AND i.item_code LIKE 'SVC-DELIVERY%')                              AS fee_line_count,
                   (SELECT COALESCE(SUM(i.total_centi), 0) FROM scm.mfg_sales_order_items i
                     WHERE i.doc_no = so2.doc_no AND NOT i.cancelled
                       AND i.item_code LIKE 'SVC-DELIVERY%')                              AS fee_line_sum
              FROM scm.mfg_sales_orders so2
             WHERE so2.doc_no = ${so.doc_no}`;
          if (Number(after.local_total_centi) !== Number(so.local_total_centi))
            return stop(`verify failed: total moved ${rm(so.local_total_centi)} → ${rm(after.local_total_centi)}`);
          if (Number(after.line_sum) !== Number(after.local_total_centi))
            return stop(`verify failed: Σ(lines) ${rm(after.line_sum)} != total ${rm(after.local_total_centi)}`);
          if (Number(after.fee_line_count) !== 1 || Number(after.fee_line_sum) !== fee)
            return stop(`verify failed: fee lines ${after.fee_line_count} Σ ${rm(after.fee_line_sum)} != 1 × ${rm(fee)}`);
          if (Number(after.fee_centi) !== fee)
            return stop(`verify failed: header fee restamped to ${rm(after.fee_centi)}`);

          // The SO's own timeline records the materialisation (same column set
          // recordSoAudit writes; everything else defaults). sql.json for the
          // same double-serialization reason as the RPC rows above — a plain
          // string here would store field_changes as a jsonb STRING, not the
          // array every reader of this table expects.
          await sql`
            INSERT INTO scm.mfg_so_audit_log
              (so_doc_no, company_id, action, actor_name_snapshot,
               field_changes, status_snapshot, source, note)
            VALUES
              (${so.doc_no}, ${so.company_id}, 'ADD_LINE',
               'repair-so-fee-line-integrity',
               ${sql.json([
                 { field: "itemCode", to: row.item_code },
                 { field: "totalCenti", to: fee },
               ])},
               ${null}, 'repair',
               'Materialised the header-carried delivery fee as a line (owner ruling 2026-08-07: every ringgit is a line). Total unchanged.')`;

          console.log(`  OK — total ${rm(after.local_total_centi)} == Σ(lines) ${rm(after.line_sum)}; fee is now a line.`);
          repaired++;
          if (!APPLY) throw new DryRunRollback("dry-run");
        });
      } catch (e) {
        if (!(e instanceof DryRunRollback)) throw e;
      }
    }

    console.log("=".repeat(76));
    notice(
      `${APPLY ? "APPLIED" : "DRY-RUN"}: ${repaired} SO(s) ${APPLY ? "repaired" : "repairable (verified in-transaction, rolled back)"}, ${refused} refused.`,
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}

/* Import-safe: the executable body runs only when invoked directly, so the
   unit test can import the pure builders without touching a database. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
