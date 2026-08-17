#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-do-so-item-links.mjs — re-point Delivery-Order lines that lost the
// Sales-Order line they were raised from.
//
// THE SYMPTOM IT HEALS (2990, reported 2026-08-17): "这些 SO 已经出货了,为什么
// MRP 还叫我下单". Eight non-cancelled DOs carried 26 lines with
// `so_item_id IS NULL`. That column is the ONLY key MRP's delivered-netting
// (soDeliverableRemaining) and the CONFIRMED -> DELIVERED flip
// (isSoFullyCovered) read, so the shipment was invisible to both while
// inventory_movements had already booked the OUT: goods gone, order still
// demanding, Procurement asked to buy it a second time.
//
// WHY A LINK CAN VANISH UNDER A DOCUMENT NOBODY EDITED. The FK is
// `delivery_order_items.so_item_id -> mfg_sales_order_items.id ON DELETE SET
// NULL`, so any delete of an SO line silently wipes every downstream
// document's record of which line it served. so-line-relink.ts carries the
// forward-looking half (freeze the links across a delete-and-reinsert); this
// script is the backward-looking half, for rows already in that state.
//
// THIS SCRIPT DOES NOT CLAIM TO KNOW WHICH PATH DID THE DELETING. It repairs
// the rows and nothing else. The live path is still open at the time of
// writing — re-run this after it is found and closed, and the run should
// report CLEAN.
//
// THE DECISION IS PURE AND TESTED — scripts/lib/do-so-link-repair.mjs
// (planDoSoLinkRepair), unit-tested in tests/doSoLinkRepair.test.ts. A repair
// is offered only when it is FORCED: same item code, same qty, exactly one
// candidate, no competing claim. Everything else is refused with a reason and
// listed for a human, because a wrong link is worse than a missing one.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - it does not touch the SO's header STATUS. That is syncSoDeliveredFromDo's
//     job and it runs on DO/DR mutations; re-deriving it here would be a second
//     hand copy of isSoFullyCovered, which is the failure shape CLAUDE.md names.
//     MRP needs no such trigger — it is a pure calculator, recomputed on every
//     GET, so the planning page is correct the moment this commits.
//   - it does not create missing DO LINES. A DO whose line rows are gone
//     entirely (2990-DO-2607-017 on the 2026-08-17 sweep: zero lines, three
//     OUT movements) needs money written onto a customer-facing document from
//     inference — an owner's call, not a script's.
//
// DRY-RUN BY DEFAULT. Same posture as repair-so-fee-line-integrity.mjs: every
// change runs inside a transaction, is verified, and is ROLLED BACK unless
// APPLY=true AND the confirmation phrase matches.
//
//   node backend/scripts/repair-do-so-item-links.mjs
//   APPLY=true CONFIRM="I HAVE REVIEWED THE DRY-RUN" node backend/scripts/repair-do-so-item-links.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { planDoSoLinkRepair } from './lib/do-so-link-repair.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

/** Thrown to force a rollback after a successful dry-run. Not an error. */
class DryRunRollback extends Error {}

async function main() {
  const url = resolveUrl();
  if (!url) {
    console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
    process.exit(1);
  }

  const APPLY = process.env.APPLY === 'true' && process.env.CONFIRM === CONFIRM_PHRASE;
  if (process.env.APPLY === 'true' && !APPLY) {
    console.log(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}" — running DRY-RUN instead.\n`);
  }

  const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  let restored = 0;
  let refusedTotal = 0;

  try {
    console.log(`\nDO->SO LINE-LINK REPAIR — ${APPLY ? 'APPLY (writes will be COMMITTED)' : 'DRY-RUN (nothing will be written)'}\n`);

    /* Candidate SOs: every non-cancelled DO that NAMES an SO in its header and
       carries at least one line with no link. The header's so_doc_no is what
       makes this repair evidence-based rather than a guess — the document
       already records which order it served; only the per-LINE pointer is gone.
       A DRAFT DO has not shipped, but its lines are still supposed to carry the
       link, so it is repaired too; nothing downstream counts it either way. */
    const docs = await pg`
      SELECT DISTINCT d.so_doc_no
        FROM scm.delivery_orders d
        JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
       WHERE d.so_doc_no IS NOT NULL
         AND d.status::text <> 'CANCELLED'
         AND di.so_item_id IS NULL
       ORDER BY d.so_doc_no`;

    if (docs.length === 0) {
      notice('No orphaned DO lines under an SO-linked delivery order. CLEAN.');
      return;
    }
    console.log(`${docs.length} sales order(s) with orphaned delivery lines.\n`);

    for (const { so_doc_no: soDocNo } of docs) {
      try {
        await pg.begin(async (tx) => {
          /* Re-read everything INSIDE the transaction — never plan from the
             discovery query. Between the two, another session may have
             delivered, cancelled or re-linked any of these rows. */
          const orphans = await tx`
            SELECT di.id, di.item_code, di.qty, d.do_number
              FROM scm.delivery_orders d
              JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
             WHERE d.so_doc_no = ${soDocNo}
               AND d.status::text <> 'CANCELLED'
               AND di.so_item_id IS NULL
             ORDER BY d.do_number, di.line_no NULLS LAST, di.id
             FOR UPDATE OF di`;
          if (orphans.length === 0) return;

          const soLines = await tx`
            SELECT id, item_code, qty
              FROM scm.mfg_sales_order_items
             WHERE doc_no = ${soDocNo} AND cancelled = false`;

          /* Claims from EVERY non-cancelled DO, not just this SO's own — an SO
             line is "already delivered" no matter which document did it. */
          const claimed = await tx`
            SELECT DISTINCT di.so_item_id
              FROM scm.delivery_order_items di
              JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
             WHERE di.so_item_id IS NOT NULL
               AND d.status::text <> 'CANCELLED'
               AND di.so_item_id IN ${tx(soLines.map((l) => l.id))}`;

          const plan = planDoSoLinkRepair(
            orphans.map((o) => ({ id: o.id, itemCode: o.item_code, qty: Number(o.qty), doNumber: o.do_number })),
            soLines.map((l) => ({ id: l.id, itemCode: l.item_code, qty: Number(l.qty) })),
            claimed.map((r) => r.so_item_id),
          );

          console.log(`  ${soDocNo}: ${plan.restore.length} to re-link, ${plan.refused.length} refused`);
          for (const r of plan.refused) {
            console.log(`    REFUSED  ${r.itemCode} x${r.qty} — ${r.reason}`);
          }
          refusedTotal += plan.refused.length;
          if (plan.restore.length === 0) return;

          for (const r of plan.restore) {
            /* The WHERE re-asserts the precondition the plan was built on, so a
               row that gained a link since the SELECT is skipped rather than
               overwritten. */
            const updated = await tx`
              UPDATE scm.delivery_order_items
                 SET so_item_id = ${r.soItemId}
               WHERE id = ${r.doItemId} AND so_item_id IS NULL
              RETURNING id`;
            if (updated.length !== 1) {
              throw new Error(`${soDocNo}: ${r.doItemId} was re-linked by another session mid-repair — rolled back`);
            }
            console.log(`    LINK     ${r.itemCode} x${r.qty} -> ${r.soItemId}`);
          }

          /* VERIFY before committing: no SO line may now read as over-delivered.
             This is the invariant the repair could break if the plan were wrong,
             so it is checked against the rows as they now stand, not asserted. */
          const over = await tx`
            SELECT s.id, s.item_code, s.qty AS ordered, SUM(di.qty) AS delivered
              FROM scm.mfg_sales_order_items s
              JOIN scm.delivery_order_items di ON di.so_item_id = s.id
              JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
             WHERE s.doc_no = ${soDocNo} AND s.cancelled = false
               AND d.status::text <> 'CANCELLED'
             GROUP BY s.id, s.item_code, s.qty
            HAVING SUM(di.qty) > s.qty`;
          if (over.length > 0) {
            throw new Error(
              `${soDocNo}: repair would over-deliver ${over.map((o) => `${o.item_code} (${o.delivered}/${o.ordered})`).join(', ')} — rolled back`,
            );
          }

          restored += plan.restore.length;
          if (!APPLY) throw new DryRunRollback();
        });
      } catch (e) {
        if (e instanceof DryRunRollback) continue;
        console.error(`  ${soDocNo}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log('');
    notice(
      `${APPLY ? 'REPAIRED' : 'WOULD REPAIR'} ${restored} delivery line(s); ${refusedTotal} refused (listed above, need a human).`,
    );
    if (!APPLY && restored > 0) {
      console.log(`\nRe-run with:  APPLY=true CONFIRM="${CONFIRM_PHRASE}" node backend/scripts/repair-do-so-item-links.mjs`);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
