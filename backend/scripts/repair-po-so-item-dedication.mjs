#!/usr/bin/env node
/* A purchase line that says it was bought for the WRONG sales line. Find them
   on one (sales order, purchase order) pair, re-point them onto the sales line
   carrying the same code and seat, and refuse anything that is not forced.

   WHAT THE COLUMN IS. `scm.purchase_order_items.so_item_id` is the DEDICATION:
   this purchase line was raised for THAT sales line. It is what the SO->PO
   chips, the PO<->SO coverage panel, the drop-ship batch expectation, the
   document relationship map and the `po_qty_picked` recount all resolve on.

   WHY A DISAGREEING ROW IS A DEFECT, not a preference. The app's own gate,
   soLinkTargetRefusal in src/scm/routes/mfg-purchase-orders.ts, answers 409
   `so_link_material_mismatch` to any bind whose two codes differ, in its own
   words because "binding a PO line for one SKU to an SO line for another makes
   every downstream reader lie". No operator can create this state through the
   UI. It arrived with the AutoCount migration, which stamped the dedication
   from the AutoCount line order rather than from the code.

   HOW IT WAS FOUND. HC-SO-012929 could not be finished. The owner ruled the
   26" build is 1A(LHF)+2A(RHF); the purchase order was corrected to exactly
   that; and apply-sofa-compartment-corrections.mjs then REFUSED the sales
   order - correctly - with "a surplus line is referenced downstream: 9028-1S:
   1 PO line(s)". The surplus 26" -1S placeholder carries the whole build's
   price and could not be removed, because the purchase order's 9028-1A(LHF)
   was dedicated to it. Measured on prod 2026-09-05 with the read-only role:
   across ALL of company 1 exactly ONE purchase line disagrees with the sales
   line it names, and it is that one.

   MATCHED BY CODE AND SEAT, NEVER BY POSITION. The two documents do not list
   their lines in the same order. Pairing by position is how a 28" single
   seater ends up dedicated to a 26" build - and on this very document there IS
   a 28" single seater, a genuine second sofa that must not be touched.

   IT REFUSES RATHER THAN PICKS. Two candidate sales lines, none, a pointer
   that leaves the document pair, a cancelled target, a quantity that would
   exceed the demand, a purchase order with no dedication to this sales order
   at all - every one is refused and printed. The planner is pure and has the
   test: scripts/lib/po-so-dedication-plan.mjs + its .test.mjs.

   IT MOVES ONE COLUMN AND NOTHING ELSE. No code, no price, no quantity, no
   row is created or removed. Both documents' money is summed BEFORE and
   asserted again on the fresh connection AFTER - both columns, both documents,
   because scm.purchase_order_items.line_total_sen is 0 on company-1 sofa lines
   while unit_price_sen carries the price, so a check on one column alone
   passes vacuously. Removing the freed placeholder is NOT this script's job:
   apply-sofa-compartment-corrections.mjs does that, under its own money and
   downstream guards.

   IT REFUSES REAL STOCK. A goods receipt that is not `migrated_no_stock`, or
   any scm.inventory_movements row naming either document, means stock actually
   moved under the present dedication and re-pointing it is not a paperwork
   fix. Sub-line allocations (scm.purchase_order_item_allocations) SUPERSEDE
   the single so_item_id, so a line that has any is refused too.

   MODE=plan (default) prints the whole plan and writes nothing. MODE=apply
   needs CONFIRM="I HAVE REVIEWED THE DRY-RUN" and CONFIRM_PO set to the
   purchase order number, writes every move in ONE transaction guarded on the
   pointer it read, and then re-reads BOTH documents on a fresh connection and
   asserts the dedication SHAPE - every purchase line's code paired with the
   code of the sales line it now names - not a row count.

   RE-RUN: inert. Keyed on a dedication that disagrees with its own line or is
   absent, which a successful move turns into a KEEP, so a second run plans
   nothing and writes nothing. */
import postgres from 'postgres';

import { K, planDedication, seatKey } from './lib/po-so-dedication-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const SO_DOC = (process.env.DOC || '').trim();
const PO_DOC = (process.env.PO || '').trim();
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!SO_DOC || !PO_DOC) {
  bad('need DOC=<sales order no> and PO=<purchase order no> — this repair works on ONE named pair');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
/* A second, stronger confirmation: the purchase order number, typed again.
   A fixed phrase can be copied out of another script's docs; this one cannot. */
if (APPLY && (process.env.CONFIRM_PO || '').trim() !== PO_DOC) {
  bad(`MODE=apply also requires CONFIRM_PO="${PO_DOC}" — the purchase order you mean, typed again`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const seatOf = (v) => {
  const s = v && typeof v === 'object' ? v.seatHeight : null;
  return s === null || s === undefined || s === '' ? null : String(s);
};
const money = (rows, totalCol) => rows.reduce(
  (a, r) => ({
    total: a.total + Number(r[totalCol] ?? 0),
    charged: a.charged + Number(r.unit_price_sen ?? 0) * Number(r.qty ?? 0),
  }),
  { total: 0, charged: 0 },
);
const show = (code, seat) => `${K(code)}${seatKey(seat) ? ` @${seatKey(seat)}"` : ''}`;

/**
 * The dedication SHAPE of the pair: for every purchase line, the code+seat it
 * orders paired with the code+seat of the sales line it names. Sorted, so it is
 * a multiset and not an order. A row count cannot see a pointer land on the
 * wrong line; this can.
 */
function dedicationShape(poRows, soRows) {
  const byId = new Map(soRows.map((r) => [r.id, r]));
  return poRows
    .map((p) => {
      const t = p.so_item_id ? byId.get(p.so_item_id) : null;
      const to = p.so_item_id ? (t ? show(t.item_code, t.seat) : `(off this order: ${p.so_item_id})`) : '(none)';
      return `${show(p.item_code, p.seat)} -> ${to}`;
    })
    .sort();
}

/** Resolve the purchase order by its number or by the AutoCount document it
 *  links to — the migrated POs are being renumbered, so the number alone is not
 *  a stable handle (same fallback apply-sofa-compartment-corrections.mjs uses). */
async function resolvePo(client) {
  const ac = PO_DOC.replace(/^HC-/, '');
  const rows = await client`SELECT id, po_number, status FROM scm.purchase_orders
     WHERE company_id = ${CO} AND (po_number = ${PO_DOC} OR linked_ac_docno = ${ac})`;
  if (rows.length !== 1) return { po: null, why: `${PO_DOC}: ${rows.length} purchase order(s) match on company ${CO}` };
  return { po: rows[0], why: null };
}

async function readPair(client, poId) {
  const soRaw = await client`SELECT i.id, i.line_no, i.item_group, i.item_code, i.qty, i.unit_price_sen,
                                    i.total_sen, i.cancelled, i.variants, i.po_qty_picked
                               FROM scm.mfg_sales_order_items i
                               JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                              WHERE h.company_id = ${CO} AND i.doc_no = ${SO_DOC}
                              ORDER BY i.line_no`;
  const poRaw = await client`SELECT i.id, i.item_group, i.item_code, i.qty, i.unit_price_sen,
                                    i.line_total_sen, i.so_item_id, i.variants, i.received_qty
                               FROM scm.purchase_order_items i
                              WHERE i.purchase_order_id = ${poId} AND i.company_id = ${CO}
                              ORDER BY i.id`;
  return {
    soRows: soRaw.map((r) => ({ ...r, seat: seatOf(r.variants) })),
    poRows: poRaw.map((r) => ({ ...r, seat: seatOf(r.variants) })),
  };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN'} company=${CO}  ${SO_DOC} <-> ${PO_DOC}`);

  const { po, why } = await resolvePo(sql);
  if (!po) { bad(why); await sql.end({ timeout: 5 }); process.exit(1); }
  if (po.po_number !== PO_DOC) note(`  ${PO_DOC}: found as ${po.po_number} via its AutoCount link`);

  const { soRows, poRows } = await readPair(sql, po.id);
  if (!soRows.length) { bad(`${SO_DOC}: no lines on company ${CO} — is that the right sales order?`); await sql.end({ timeout: 5 }); process.exit(1); }

  const beforeSo = money(soRows, 'total_sen');
  const beforePo = money(poRows, 'line_total_sen');
  const beforeShape = dedicationShape(poRows, soRows);

  note(`\n${SO_DOC}  (${soRows.length} line(s), money total ${beforeSo.total}, charged ${beforeSo.charged})`);
  for (const r of soRows) note(`  ${String(r.line_no).padStart(3)}  ${show(r.item_code, r.seat).padEnd(22)} qty ${r.qty}  price ${r.unit_price_sen}  total ${r.total_sen}${r.cancelled ? '  CANCELLED' : ''}  ${r.id}`);
  note(`\n${po.po_number}  [${po.status}]  (${poRows.length} line(s), money total ${beforePo.total}, charged ${beforePo.charged})`);
  for (const r of poRows) note(`  ${show(r.item_code, r.seat).padEnd(22)} qty ${r.qty}  recv ${r.received_qty}  price ${r.unit_price_sen}  total ${r.line_total_sen}  -> ${r.so_item_id ?? '(none)'}`);
  note('\ndedication now:');
  for (const line of beforeShape) note(`  ${line}`);

  const plan = planDedication({ poRows, soRows });
  note('');
  for (const k of plan.keeps) note(`  keep    ${show(poRows.find((p) => p.id === k.poItemId)?.item_code, poRows.find((p) => p.id === k.poItemId)?.seat)}`);
  for (const r of plan.refusals) note(`  REFUSED ${r}`);

  /* ── The guards that need the database, applied to the PLANNED moves only ── */
  const moves = [];
  const mv = await sql`SELECT source_doc_no, count(*)::int n FROM scm.inventory_movements
                        WHERE company_id = ${CO} AND source_doc_no IN (${SO_DOC}, ${po.po_number})
                        GROUP BY source_doc_no`;
  if (mv.length) {
    for (const m of mv) bad(`${m.source_doc_no}: ${m.n} inventory movement(s) name it — real stock moved under the present dedication, REFUSED`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  for (const m of plan.moves) {
    const src = poRows.find((p) => p.id === m.poItemId);
    const blockers = [];
    const grns = await sql`SELECT DISTINCT g.grn_number, g.migrated_no_stock
                             FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                            WHERE gi.purchase_order_item_id = ${m.poItemId}`;
    for (const g of grns) if (g.migrated_no_stock !== true) blockers.push(`${g.grn_number} is not migrated paperwork — it moved stock`);
    const [{ n: allocs }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_item_allocations
                                       WHERE purchase_order_item_id = ${m.poItemId}`;
    if (allocs) blockers.push(`${allocs} sub-line allocation(s) supersede this line's single dedication — out of this repair's scope`);
    if (blockers.length) { bad(`${show(src.item_code, src.seat)}: ${blockers.join('; ')}`); continue; }
    const paper = grns.map((g) => g.grn_number).join(', ');
    const from = soRows.find((r) => r.id === m.from);
    const to = soRows.find((r) => r.id === m.to);
    note(`  MOVE    ${show(src.item_code, src.seat)}  ${m.why === 'unbound' ? 'was dedicated to NOTHING' : `was dedicated to ${show(from?.item_code, from?.seat)} (${m.from})`}  ->  ${show(to.item_code, to.seat)} (${m.to})${paper ? `   [goods receipt ${paper}, migrated paperwork]` : ''}`);
    moves.push(m);
  }

  for (const id of plan.freedSoItemIds) {
    const r = soRows.find((x) => x.id === id);
    if (moves.some((m) => m.from === id)) note(`  FREED   ${show(r?.item_code, r?.seat)} (${id}) — no purchase line points at it after this; removing it stays apply-sofa-compartment-corrections.mjs's job`);
  }

  /* po_qty_picked is a DERIVED counter (recomputeSoPicked, mfg-purchase-orders.ts).
     The migrated corpus never rolled it — every line of this pair reads 0 — so
     this repair does not write it, and asserts it does not change. Recomputing
     it here would make this one sales order differ from every other migrated
     one for a reason that has nothing to do with the pointer. */
  const pickedBefore = new Map(soRows.map((r) => [r.id, Number(r.po_qty_picked ?? 0)]));
  note(`\npo_qty_picked on the affected sales lines (derived, NOT written here): ${[...new Set([...moves.map((m) => m.from), ...moves.map((m) => m.to)])].filter(Boolean).map((id) => `${show(soRows.find((r) => r.id === id)?.item_code, soRows.find((r) => r.id === id)?.seat)}=${pickedBefore.get(id)}`).join(', ') || '(none)'}`);

  note(`\nplanned moves ${moves.length} · kept ${plan.keeps.length} · refused ${plan.refusals.length}`);
  if (!APPLY) {
    note('\nPLAN — set MODE=apply (with CONFIRM and CONFIRM_PO) to write.');
    await sql.end({ timeout: 5 });
    return;
  }
  if (!moves.length) {
    note('\nnothing to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  let wrote = 0;
  await sql.begin(async (tx) => {
    for (const m of moves) {
      /* Guarded on the pointer this run READ: if anything moved it since, the
         update matches nothing and the whole transaction is abandoned rather
         than overwriting a decision somebody else made. */
      const back = m.from === null
        ? await tx`UPDATE scm.purchase_order_items SET so_item_id = ${m.to}
                    WHERE id = ${m.poItemId} AND company_id = ${CO} AND so_item_id IS NULL
                RETURNING id`
        : await tx`UPDATE scm.purchase_order_items SET so_item_id = ${m.to}
                    WHERE id = ${m.poItemId} AND company_id = ${CO} AND so_item_id = ${m.from}
                RETURNING id`;
      if (back.length !== 1) throw new Error(`${m.poItemId}: the dedication changed under this run (expected ${m.from ?? 'NULL'}) — nothing written`);
      wrote += back.length;
    }
  });
  note(`\nwritten: ${wrote} of ${moves.length}`);
  await sql.end({ timeout: 5 });

  await verifyOnFreshConnection({ poId: po.id, poNumber: po.po_number, moves, beforeSo, beforePo, pickedBefore });
}

/**
 * Re-read BOTH documents on a NEW connection and assert the dedication SHAPE —
 * every purchase line's code paired with the code of the sales line it now
 * names — plus both money columns on both documents, and the derived
 * po_qty_picked this repair promised not to touch.
 */
async function verifyOnFreshConnection({ poId, poNumber, moves, beforeSo, beforePo, pickedBefore }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failures = 0;
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    const { soRows, poRows } = await readPair(check, poId);
    const byId = new Map(soRows.map((r) => [r.id, r]));

    for (const line of dedicationShape(poRows, soRows)) note(`  ${line}`);

    for (const m of moves) {
      const p = poRows.find((x) => x.id === m.poItemId);
      const t = p?.so_item_id ? byId.get(p.so_item_id) : null;
      const ok = p && p.so_item_id === m.to && t && K(t.item_code) === K(p.item_code) && seatKey(t.seat) === seatKey(p.seat);
      if (!ok) { failures++; bad(`  ${m.poCode}: reads ${p?.so_item_id ?? '(none)'}, expected ${m.to} — and its code must equal the sales line's`); }
      else note(`  OK  ${show(p.item_code, p.seat)} is dedicated to ${show(t.item_code, t.seat)} (${t.id})`);
    }

    /* Nothing may point at a sales line whose code is not its own — the state
       soLinkTargetRefusal refuses, asserted over the WHOLE pair, not only the
       rows this run touched. */
    for (const p of poRows) {
      const t = p.so_item_id ? byId.get(p.so_item_id) : null;
      if (t && K(t.item_code) !== K(p.item_code)) { failures++; bad(`  ${show(p.item_code, p.seat)} still names a sales line for ${K(t.item_code)}`); }
    }

    const afterSo = money(soRows, 'total_sen');
    const afterPo = money(poRows, 'line_total_sen');
    if (afterSo.total !== beforeSo.total || afterSo.charged !== beforeSo.charged) {
      failures++; bad(`  ${SO_DOC} money moved ${beforeSo.total}/${beforeSo.charged} -> ${afterSo.total}/${afterSo.charged}`);
    } else note(`  OK  ${SO_DOC} money unchanged: total ${afterSo.total}, charged ${afterSo.charged}`);
    if (afterPo.total !== beforePo.total || afterPo.charged !== beforePo.charged) {
      failures++; bad(`  ${poNumber} money moved ${beforePo.total}/${beforePo.charged} -> ${afterPo.total}/${afterPo.charged}`);
    } else note(`  OK  ${poNumber} money unchanged: total ${afterPo.total}, charged ${afterPo.charged}`);

    for (const r of soRows) {
      const was = pickedBefore.get(r.id);
      if (was !== undefined && Number(r.po_qty_picked ?? 0) !== was) {
        failures++; bad(`  ${show(r.item_code, r.seat)} po_qty_picked moved ${was} -> ${r.po_qty_picked} — this repair writes one column and that is not it`);
      }
    }
    if (!failures) note(`  OK  po_qty_picked unchanged on all ${soRows.length} sales line(s)`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failures) { console.error(`VERIFY FAILED — ${failures} assertion(s)`); process.exit(1); }
  note('VERIFY OK — dedication shape, both money columns on both documents, and the derived counter');
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
