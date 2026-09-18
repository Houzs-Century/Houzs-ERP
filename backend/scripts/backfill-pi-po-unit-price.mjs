#!/usr/bin/env node
// Stamp the PURCHASE ORDER's unit price onto purchase-invoice lines written
// before the trail column existed (migration 20260914T0200).
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// WHY. Owner, 2026-09-14: the PO price beside the invoice price is a reference
// trail — 「只要我 edit 过了，系统就直接把原来的 PO 价钱留痕下来」. New lines take it
// at insert (lib/pi-po-price.ts stampPoPriceSnapshot). Existing lines have NULL,
// and until they are stamped the detail page reads them through the live join,
// which a later purchase-order amendment can change.
//
// WHAT THE STAMPED VALUE IS, stated plainly: the purchase-order line's price AS
// OF THIS RUN, not as of the day the invoice was written — no history of PO
// prices exists to read the older value from. Where a PO has been amended since
// the invoice, this run records the amended price. The plan prints how many
// lines sit on a purchase order with more than one revision so that is visible
// before anyone applies.
//
// SCOPE. A line is stamped only when its whole chain exists:
//   purchase_invoice_items.grn_item_id -> grn_items.purchase_order_item_id
//     -> purchase_order_items.unit_price_sen
// A line with no chain (a PI-native line, a receipt with no PO) stays NULL —
// that is the honest "no PO link", never a guessed number. A PO line priced 0
// is stamped 0: the order named no price, and the screens say so.
//
// Touches ONLY po_unit_price_sen. The billed price, totals, AP, GL and the
// AutoCount outbox are not read or written.
//
// RE-RUN: inert. A stamped line no longer matches `po_unit_price_sen IS NULL`,
// so the second run plans nothing except lines that still have no chain.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional; absent = every company, reported per company
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: STAMP THE PO PRICE ON INVOICE LINES
import postgres from 'postgres';

const CONFIRM_PHRASE = 'STAMP THE PO PRICE ON INVOICE LINES';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
// The refusal lives AT the comparison, its exit adjacent.
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
if (CO !== null && !Number.isInteger(CO)) { console.error('COMPANY_ID must be an integer'); process.exit(2); }
const APPLY = WANTS_APPLY;
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

try {
  line('='.repeat(78));
  line('PURCHASE-INVOICE LINES WITH NO PO-PRICE TRAIL — stamp it from the purchase order');
  line('='.repeat(78));
  line(`   company ${CO ?? 'ALL'}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  const col = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'purchase_invoice_items' AND column_name = 'po_unit_price_sen'`;
  if (col.length === 0) {
    line('scm.purchase_invoice_items.po_unit_price_sen does not exist on this database — migration 20260914T0200 has not run here. Nothing to do.');
  } else {
    const rows = await sql`
      SELECT c.code AS company, pii.id, pi.invoice_number, pii.item_code,
             p.unit_price_sen AS po_price, (p.id IS NOT NULL) AS has_chain,
             coalesce(po.revision, 1) AS po_revision
        FROM scm.purchase_invoice_items pii
        JOIN scm.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
        JOIN public.companies c ON c.id = pi.company_id
        LEFT JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
        LEFT JOIN scm.purchase_order_items p ON p.id = gi.purchase_order_item_id
        LEFT JOIN scm.purchase_orders po ON po.id = p.purchase_order_id
       WHERE pii.po_unit_price_sen IS NULL
         AND (${CO}::bigint IS NULL OR pi.company_id = ${CO})
       ORDER BY c.code, pi.invoice_number, pii.id`;

    const writable = rows.filter((r) => r.has_chain);
    const held = rows.filter((r) => !r.has_chain);
    const byCo = new Map();
    for (const r of rows) {
      const k = byCo.get(r.company) ?? { writable: 0, priced: 0, unpriced: 0, amended: 0, held: 0 };
      if (r.has_chain) {
        k.writable += 1;
        if (Number(r.po_price) > 0) k.priced += 1; else k.unpriced += 1;
        if (Number(r.po_revision) > 1) k.amended += 1;
      } else k.held += 1;
      byCo.set(r.company, k);
    }
    rule();
    line(`   lines with no trail yet   ${rows.length}`);
    for (const [co, k] of byCo) {
      line(`   ${String(co).padEnd(8)} WRITABLE ${k.writable} (PO priced ${k.priced}, PO named no price ${k.unpriced}; on an amended PO ${k.amended})   LEFT NULL, no PO link ${k.held}`);
    }
    rule();
    for (const r of held.slice(0, 15)) line(`   NO PO LINK  ${String(r.invoice_number).padEnd(20)} ${String(r.item_code).padEnd(24)} stays NULL`);
    if (held.length > 15) line(`   and ${held.length - 15} more with no PO link`);

    if (!APPLY) {
      rule();
      line('PLAN ONLY — nothing was written.');
      line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    } else {
      const ids = writable.map((r) => r.id);
      let wrote = 0;
      if (ids.length) {
        /* Copied across in SQL from the parent column. The NULL guard is repeated
           so a line stamped at insert between plan and write is never overwritten. */
        const res = await sql`
          UPDATE scm.purchase_invoice_items pii
             SET po_unit_price_sen = p.unit_price_sen
            FROM scm.grn_items gi, scm.purchase_order_items p
           WHERE pii.id = ANY(${ids})
             AND pii.po_unit_price_sen IS NULL
             AND gi.id = pii.grn_item_id
             AND p.id = gi.purchase_order_item_id`;
        wrote = Number(res.count ?? 0);
      }
      line(`APPLIED — ${wrote} invoice line(s) now carry their purchase order's price.`);

      /* VERIFY on a FRESH connection, asserting the SHAPE: each planned line holds
         an integer equal to its purchase-order line's price, and no line without
         a PO link was written. */
      const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
      try {
        const bad = ids.length
          ? await check`
              SELECT pii.id, pii.item_code, pii.po_unit_price_sen, p.unit_price_sen AS po_price,
                     pg_typeof(pii.po_unit_price_sen)::text AS shape
                FROM scm.purchase_invoice_items pii
                JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
                JOIN scm.purchase_order_items p ON p.id = gi.purchase_order_item_id
               WHERE pii.id = ANY(${ids})
                 AND (pii.po_unit_price_sen IS DISTINCT FROM p.unit_price_sen
                      OR pg_typeof(pii.po_unit_price_sen)::text <> 'integer')`
          : [];
        const heldIds = held.map((r) => r.id);
        const touchedHeld = heldIds.length
          ? await check`SELECT count(*)::int AS n FROM scm.purchase_invoice_items WHERE id = ANY(${heldIds}) AND po_unit_price_sen IS NOT NULL`
          : [{ n: 0 }];
        if (bad.length || Number(touchedHeld[0].n) > 0) {
          line(`VERIFY FAILED — ${bad.length} stamped line(s) disagree with their PO line; ${touchedHeld[0].n} no-link line(s) were written.`);
          for (const b of bad.slice(0, 6)) line(`   ${b.item_code}: stored ${b.po_unit_price_sen} (${b.shape}) vs PO ${b.po_price}`);
          process.exitCode = 1;
        } else {
          line(`VERIFY OK — ${ids.length} line(s) hold their purchase order's price as an integer; ${heldIds.length} no-link line(s) still NULL.`);
        }
      } finally {
        await check.end({ timeout: 5 });
      }
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
