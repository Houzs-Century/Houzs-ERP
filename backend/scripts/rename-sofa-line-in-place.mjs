#!/usr/bin/env node
// Rename ONE sofa line's item code IN PLACE, on one named document.
// DRY-RUN by default; APPLY=1 needs CONFIRM to repeat the document number.
//
// WHY THIS EXISTS, AND WHY THE CORRECTIONS APPLIER CANNOT DO IT.
// `apply-sofa-compartment-corrections.mjs` rewrites a BUILD: it pairs rows by
// CODE and re-shapes the set, which is right when a build gained or lost a
// piece. A one-piece rename is a different operation wearing the same clothes —
// it reads as "remove 1A(RHF), add L(RHF)", and on a document where more than
// one line carries money the price cannot ride the first piece, so its money
// guard (correctly) refuses. Measured on HC-PO-2609-053, run 34570088451:
//
//   REFUSED — money would move — total 273000 -> 106000, charged 273000 -> 106000
//
// Nothing about that sofa's money is wrong. One row's item code is. So this
// tool changes exactly that: `item_code`, and nothing else — the row id, its
// price, its quantity, its `so_item_id` dedication, its variants and its
// description2 all stay, which is what keeps the purchase line attached to the
// sales line it was raised from.
//
// THE CASE IT WAS WRITTEN FOR (owner + purchasing, 2026-09-11, urgent):
// `SO-013503 / PO2609-053 the item code convert wrong, need 1A(LHF)+1NA+L(RHF)`.
// The third piece is a LOUNGER — the taller box on the drawing — read as an arm
// on 2026-09-10. The sales order was corrected through the normal channel (run
// 34570012915, VERIFY OK); the purchase order is this.
//
// WHAT IT REFUSES
//   · more than one line on the document matches FROM (pass LINE_ID to name one);
//   · anything received against that line, or any goods-received line hanging off
//     it — a code change under received goods strands the lot, and that is the
//     stock-aware tool's job, not this one;
//   · a TO code the catalogue has not minted (`scm.mfg_products`), the same set
//     the corrections applier checks;
//   · a line whose item group is not sofa.
//
// RE-RUN: inert. The second run finds no line carrying FROM on that document and
// reports 0 to rename; it can never rename twice, because it keys on the code it
// is replacing.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   DOC            required — HC-PO-2609-053 (purchase) or HC-SO-013503 (sales)
//   FROM, TO       required — item codes
//   LINE_ID        optional — the row, when FROM matches more than one
//   APPLY=1 + CONFIRM=<DOC>   to write
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOC = String(process.env.DOC || '').trim();
const FROM = String(process.env.FROM || '').trim();
const TO = String(process.env.TO || '').trim();
const LINE_ID = String(process.env.LINE_ID || '').trim();
const WANTS_APPLY = process.env.APPLY === '1';
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
if (!DOC || !FROM || !TO) { console.error('need DOC, FROM and TO'); process.exit(2); }
// The refusal lives AT the comparison, its exit adjacent: CONFIRM must repeat the
// document number, so an APPLY aimed at the wrong document cannot be a typo.
if (WANTS_APPLY && process.env.CONFIRM !== DOC) {
  console.error(`APPLY=1 requires CONFIRM="${DOC}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

const K = (s) => String(s ?? '').trim().toUpperCase();
/** `9058-2A(RHF)` -> `2A(RHF)`, and a piece token inside free text. No trailing
 *  word boundary: a token ending in `)` has none after it, which is the miss
 *  that made the first name audit report 0 of 17 (docs/bugs/0818). */
const pieceOf = (code) => { const s = K(code); const i = s.indexOf('-'); return i < 0 ? s : s.slice(i + 1); };
const PIECE_RX = /(\d?[ABL]?\d?[A-Z]{0,3}\((?:LHF|RHF)\)|\bCNR\b|\bCONSOLE\b|\bSTOOL\b|\b\dS\b|\b\dNA\b)/i;
{
  const ok = ['SOFA VERANO 2A(LHF)', 'SOFA SOFFIO 1S'].every((x) => PIECE_RX.test(x))
    && !['AMN SOFA - SF9058', 'HOK SOFA - 5536'].some((x) => PIECE_RX.test(x))
    && 'SOFA VERANO 2A(LHF)'.replace(PIECE_RX, 'L(RHF)') === 'SOFA VERANO L(RHF)';
  if (!ok) { console.error('SELF-TEST FAILED on the piece matcher. Refusing to run.'); process.exit(1); }
}
const isPo = /-PO-/i.test(DOC);
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

async function readRows() {
  if (isPo) {
    const [po] = await sql`SELECT id FROM scm.purchase_orders WHERE company_id = ${CO} AND po_number = ${DOC}`;
    if (!po) return null;
    return {
      rows: await sql`SELECT id, item_code, qty, received_qty, unit_price_sen, so_item_id,
                             description, material_name, coalesce(item_group, '') AS item_group
                        FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id} ORDER BY id`,
    };
  }
  const rows = await sql`SELECT i.id, i.item_code, i.qty, 0 AS received_qty, i.unit_price_sen,
                                i.description, NULL::text AS material_name,
                                NULL::text AS so_item_id, coalesce(i.item_group, '') AS item_group
                           FROM scm.mfg_sales_order_items i
                           JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
                          WHERE s.company_id = ${CO} AND i.doc_no = ${DOC} ORDER BY i.id`;
  return rows.length ? { rows } : null;
}

try {
  line('='.repeat(78));
  line(`RENAME ONE SOFA LINE IN PLACE — ${DOC}: ${FROM} -> ${TO}`);
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  line('='.repeat(78));

  const found = await readRows();
  if (!found) { line(`REFUSED — no ${isPo ? 'purchase' : 'sales'} order ${DOC} on company ${CO}.`); process.exitCode = 1; }
  else {
    const { rows } = found;
    line(`   the document holds: ${rows.map((r) => r.item_code).join(' + ')}`);

    const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
    const minted = new Set(prods.map((p) => K(p.code)));

    const matches = rows.filter((r) => K(r.item_code) === K(FROM) && (!LINE_ID || String(r.id) === LINE_ID));
    const refuse = (why) => { line(`REFUSED — ${why}`); process.exitCode = 1; };

    if (!matches.length) line(`   nothing to rename: no line on ${DOC} carries ${FROM}${LINE_ID ? ` at row ${LINE_ID}` : ''}.`);
    else if (matches.length > 1) refuse(`${matches.length} lines carry ${FROM} (${matches.map((r) => r.id).join(', ')}) — pass LINE_ID to name the one`);
    else if (!minted.has(K(TO))) refuse(`piece SKU not minted: ${TO}`);
    else {
      const row = matches[0];
      const [{ n: grn }] = isPo
        ? await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ${row.id}`
        : [{ n: 0 }];
      const [{ n: dos }] = isPo
        ? [{ n: 0 }]
        : await sql`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE so_item_id = ${row.id}`;

      if (Number(row.received_qty || 0) > 0) refuse(`${row.received_qty} already received on that line — a code change under received goods strands the lot`);
      else if (Number(grn) > 0) refuse(`${grn} goods-received line(s) hang off that line`);
      else if (Number(dos) > 0) refuse(`${dos} delivery line(s) hang off that line`);
      else if (K(row.item_group) !== 'SOFA') refuse(`that line's item group is "${row.item_group}", not sofa`);
      else {
        line(`   RENAME  row ${row.id}  ${row.item_code} -> ${TO}   qty ${row.qty} · RM ${(Number(row.unit_price_sen) / 100).toFixed(2)} · dedication ${row.so_item_id ? 'kept' : 'none'}`);
        line('   money, quantity, dedication and variants all stay as they are.');
        /* THE NAME MOVES WITH THE CODE. A document prints `description ??
           material_name` beside the code (sales-order-pdf.ts:572,
           grn-pdf.ts:133), so renaming the code alone leaves the row printing
           two different pieces — which is what the owner found on the very
           document this tool was written for (docs/bugs/0818). Only the piece
           TOKEN is rewritten; the model word keeps whatever it says, and a name
           that states no piece (the supplier's own product name) is left alone. */
        const nameCols = isPo ? ['description', 'material_name'] : ['description'];
        const renames = [];
        for (const col of nameCols) {
          const before = row[col];
          if (before === null || before === undefined || String(before).trim() === '') continue;
          if (!PIECE_RX.test(String(before))) continue;          // the supplier's own product name
          const after = String(before).replace(PIECE_RX, pieceOf(TO));
          if (after !== String(before)) renames.push({ col, before: String(before), after });
        }
        for (const r of renames) line(`   RENAME  ${r.col}: ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
        if (!renames.length) line('   the printed name states no piece (or already states this one) — left as it is.');

        if (!APPLY) {
          line(`DRY-RUN — nothing was written. To write: APPLY=1 CONFIRM="${DOC}"`);
        } else {
          const table = isPo ? 'purchase_order_items' : 'mfg_sales_order_items';
          /* The code and every printed name in ONE statement: no window exists
             in which the row says two different pieces. */
          const sets = ['item_code = $1', ...renames.map((r, i) => `${r.col} = $${i + 3}`)].join(', ');
          await sql.unsafe(
            `UPDATE scm.${table} SET ${sets} WHERE id = $2`,
            [TO, row.id, ...renames.map((r) => r.after)],
          );
          line(`APPLIED — 1 line renamed${renames.length ? `, and ${renames.length} printed name(s) with it` : ''}.`);

          /* VERIFY on a FRESH connection, and assert the SHAPE — the document's
             whole piece list — not just that one row reads the new code. The
             session that wrote is the worst witness that the write landed. */
          const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
          try {
            const after = isPo
              ? await check`SELECT i.item_code FROM scm.purchase_order_items i
                              JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                             WHERE p.company_id = ${CO} AND p.po_number = ${DOC} ORDER BY i.id`
              : await check`SELECT i.item_code FROM scm.mfg_sales_order_items i
                              JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
                             WHERE s.company_id = ${CO} AND i.doc_no = ${DOC} ORDER BY i.id`;
            const shape = after.map((r) => r.item_code);
            const stillOld = shape.filter((c) => K(c) === K(FROM)).length;
            const nowNew = shape.filter((c) => K(c) === K(TO)).length;
            line(`VERIFY — ${DOC} now reads: ${shape.join(' + ')}`);
            if (nowNew >= 1 && stillOld === 0) line('VERIFY OK — the renamed piece is there and the old code is gone.');
            else { line(`VERIFY FAILED — ${stillOld} line(s) still carry ${FROM}, ${nowNew} carry ${TO}.`); process.exitCode = 1; }
          } finally {
            await check.end({ timeout: 5 });
          }
        }
      }
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
