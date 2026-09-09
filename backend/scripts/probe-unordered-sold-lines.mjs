#!/usr/bin/env node
/* READ-ONLY. SOLD, RELEASED FOR PURCHASING, AND NEVER ORDERED — how many?
 *
 * WHY THIS EXISTS. HC-SO-012949 sells a CODY single bedframe that no purchase
 * order anywhere on company 1 carries: not dedicated to that line, not on any
 * other document, and absent from AutoCount's own export too. The gap is in
 * the BOOK, not in the copy of it, so minting a purchase order would put a
 * document in the ERP that the account book does not have — and because a
 * bedframe is HARD-BOUND it would then read READY the moment anything arrived
 * against that invented document.
 *
 * The build itself is one line and a person can chase it. The question worth a
 * script is the one nobody had asked: IS IT THE ONLY ONE? A single missed
 * order is a phone call; twenty is a hole in the migration, and the difference
 * has to be measured rather than assumed.
 *
 * ── WHAT COUNTS AS THIS SHAPE, and why each condition is there ──────────────
 *
 *   HARD-BOUND     bedframe / sofa / an (SP) special-order mattress —
 *                  `isHardBoundLine`, backend/src/scm/lib/so-stock-allocation.ts.
 *                  On company 1 those lines light ONLY through their own
 *                  dedicated purchase order's received quantity (the owner,
 *                  ruled three times). A mattress or an accessory sold off the
 *                  shelf legitimately has no purchase order and is NOT this
 *                  shape — including them would bury the finding in hundreds of
 *                  correct rows.
 *   PROCEEDED      the order carries a Processing Date. That date IS the
 *                  release for purchasing to order (owner 2026-08-18); before
 *                  it, having no purchase order is the normal state of a
 *                  perfectly good order and not a gap.
 *   STILL OWED     the order's status is not one of SO_TERMINAL_STATES —
 *                  cancelled, closed, shipped, delivered, invoiced, draft. The
 *                  goods have not left, so somebody is still waiting for them.
 *   NOT CANCELLED  the line itself.
 *   NO DEDICATION  no scm.purchase_order_items row names this line.
 *
 * and then the answer SPLITS, because the two halves are different problems:
 *
 *   NEVER ORDERED  the item code appears on ZERO company-1 purchase-order
 *                  lines. Nothing was ever bought. This is the CODY shape and
 *                  it is purchasing's to chase.
 *   UNDEDICATED    the code IS on some company-1 purchase order, just not
 *                  pointed at this line. That is a missing pointer, which
 *                  repair-po-so-item-dedication.mjs exists for — a different
 *                  repair, reported separately so the two are never added
 *                  together into one alarming number.
 *
 * ONE STATEMENT ANSWERS IT. The split, the counts and the printing are done in
 * JavaScript over that one result set, so the database is asked exactly one
 * question.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. No UPDATE, no INSERT, no DDL, no
 * transaction. It exits 0 for every legitimate answer, INCLUDING zero rows —
 * "nothing is in this shape" is the best possible answer and must not read as
 * a broken check. Non-zero means the database could not be read.
 *
 *   DATABASE_URL   required
 *   COMPANY        default 1
 *   LIMIT          default 200 rows printed; the COUNTS are always complete
 *
 * RE-RUN: idempotent and side-effect free — one SELECT and a print.
 */
import postgres from "postgres";

import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const LIMIT = Number(process.env.LIMIT || 200);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const seatOf = (v) => (v && typeof v === "object" && v.seatHeight ? ` @${v.seatHeight}"` : "");
const colourOf = (v) => (v && typeof v === "object" && v.colourLabel ? ` ${v.colourLabel}` : "");

async function main() {
  note(`READ-ONLY. company=${CO}  terminal statuses excluded: ${SO_TERMINAL_STATES.join(", ")}`);
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    /* ONE statement. `isHardBoundLine` is mirrored here as SQL rather than
       imported because it is a TypeScript module — bedframe / sofa by group,
       plus a mattress whose code ends in (SP). If that predicate ever changes,
       this line changes with it; it is stated in the header so a reader can
       check the pair. */
    const rows = await sql`
      SELECT h.doc_no,
             UPPER(COALESCE(h.status::text, '')) AS status,
             h.processing_date,
             h.debtor_name,
             i.id::text            AS line_id,
             i.line_no,
             i.item_group,
             i.item_code,
             i.qty,
             i.variants,
             i.stock_status,
             i.po_qty_picked,
             (SELECT COUNT(*)::int FROM scm.purchase_order_items pi
               WHERE pi.so_item_id = i.id)                       AS dedicated_po_lines,
             (SELECT COUNT(*)::int FROM scm.purchase_order_items pi
                JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
               WHERE p.company_id = ${CO}
                 AND UPPER(BTRIM(pi.item_code)) = UPPER(BTRIM(i.item_code))) AS po_lines_with_this_code
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO}
         AND COALESCE(i.cancelled, false) = false
         AND UPPER(COALESCE(h.status::text, '')) <> ALL (${SO_TERMINAL_STATES})
         AND h.processing_date IS NOT NULL
         AND (LOWER(COALESCE(i.item_group, '')) IN ('bedframe', 'sofa')
              OR (LOWER(COALESCE(i.item_group, '')) = 'mattress'
                  AND COALESCE(i.item_code, '') ~* '\\(SP\\)\\s*$'))
       ORDER BY h.processing_date, h.doc_no, i.line_no`;

    const undedicated = rows.filter((r) => r.dedicated_po_lines === 0);
    const neverOrdered = undedicated.filter((r) => r.po_lines_with_this_code === 0);
    const pointerMissing = undedicated.filter((r) => r.po_lines_with_this_code > 0);

    note("");
    note(`hard-bound lines still owed on a PROCEEDED order: ${rows.length}`);
    note(`  of those, with NO purchase line dedicated to them: ${undedicated.length} / ${rows.length}`);
    note(`    NEVER ORDERED  (the code is on 0 company-${CO} purchase lines): ${neverOrdered.length} / ${rows.length}`);
    note(`    UNDEDICATED    (the code IS bought somewhere, the pointer is missing): ${pointerMissing.length} / ${rows.length}`);

    const show = (title, list, extra) => {
      note("");
      note(`== ${title}: ${list.length} ==`);
      if (!list.length) { note("   (none)"); return; }
      for (const r of list.slice(0, LIMIT)) {
        note(`   ${r.doc_no}  L${String(r.line_no).padStart(3)}  ${String(r.item_code).padEnd(26)}`
          + `${seatOf(r.variants)}${colourOf(r.variants)}  qty ${r.qty}  ${r.item_group}`
          + `  status ${r.status}  proceeded ${r.processing_date ?? "-"}`
          + `  stock ${r.stock_status ?? "-"}  po_qty_picked ${r.po_qty_picked ?? 0}`
          + `  ${extra(r)}  customer ${r.debtor_name ?? "-"}`);
      }
      if (list.length > LIMIT) note(`   ... ${list.length - LIMIT} more not printed (LIMIT=${LIMIT})`);
    };

    show("NEVER ORDERED - nothing on company " + CO + " ever bought this code", neverOrdered,
      () => "po lines with this code: 0");
    show("UNDEDICATED - bought, but no purchase line points at this sales line", pointerMissing,
      (r) => `po lines with this code: ${r.po_lines_with_this_code}`);

    note("");
    note(neverOrdered.length
      ? `VERDICT: ${neverOrdered.length} hard-bound line(s) were sold, released for purchasing, and never ordered. Each can never read READY, because a company-1 hard-bound line lights only through its own dedicated purchase order.`
      : "VERDICT: no hard-bound line on a proceeded, still-owed order is missing a purchase order entirely.");
    note("nothing was written");
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
