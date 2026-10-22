// One-off, GATED repair: remove a SINGLE service/charge line from a Sales Order
// and sync the removal to AutoCount.
//
// WHY A SCRIPT. The app's own DELETE-line route refuses a processing-locked /
// delivered order (soProcessingLockBlocked, routes/mfg-sales-orders.ts), so the
// only in-app path is an amendment. When the desk cannot raise/approve one, this
// does the SAME work the delete route does — but a raw DB delete alone would
// never enqueue the AutoCount write-back (no DB trigger; pgrestShim suppresses by
// default), leaving the book holding the line live and outstanding.
//
// HOW IT STAYS SAFE. Nothing about the accounting payload is hand-crafted:
//   - retiredLineOf() reads the removed line's AutoCount DtlKey BEFORE the delete,
//   - enqueueEdit({ retire }) lets composeSoState build the exact rebuild-or-retire
//     payload the delete route would,
//   - the header roll-up mirrors routes/mfg-sales-orders.ts recomputeTotals for
//     the NON-sofa path (this repair only removes SERVICE lines; a sofa order needs
//     the combo-cost spread and must go through the app instead — refused below),
//   - recordSoAudit() writes the same DELETE_LINE row, with REASON in `note`.
// Everything runs in ONE transaction over `postgres`, so a failure rolls back.
//
// SCOPE GUARDS (refuses rather than guess):
//   - the line must match DOC + LINE_ID + ITEM_CODE (never delete the wrong line),
//   - it must be a SERVICE line (removing a goods line can orphan free gifts or
//     change the delivery-fee mix, which this script does NOT re-derive),
//   - it must carry NO live DO / SI reference (the per-line freeze).
//
// DRY-RUN by default (reads + previews the new totals and the retire; writes
// nothing). MODE=apply performs it.
//   DOC=HC-SO-011427 LINE_ID=<uuid> ITEM_CODE=STORAGE \
//   REASON="need to remove storage charges" CONFIRM="REMOVE SO LINE" MODE=apply \
//   npx tsx scripts/remove-so-storage-line.mts
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { enqueueEdit, retiredLineOf } from '../src/scm/lib/autocount-outbox';
import { recordSoAudit } from '../src/scm/lib/so-audit';
import { isServiceLine, isDeliveryFeeServiceCode } from '../src/scm/shared/service-sku';

const apply = String(process.env.MODE || 'dry-run').toLowerCase() === 'apply';
const DOC = (process.env.DOC || '').trim();
const LINE_ID = (process.env.LINE_ID || '').trim();
const ITEM_CODE = (process.env.ITEM_CODE || '').trim();
const REASON = (process.env.REASON || '').trim();
const CONFIRM = (process.env.CONFIRM || '').trim();

if (!DOC || !LINE_ID || !ITEM_CODE) {
  console.error('DOC, LINE_ID and ITEM_CODE are all required.');
  process.exit(2);
}
if (apply && !REASON) { console.error('REASON is required to apply (audit trail).'); process.exit(2); }
if (apply && CONFIRM !== 'REMOVE SO LINE') { console.error('CONFIRM must be exactly "REMOVE SO LINE" to apply.'); process.exit(2); }

function resolveUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error('DATABASE_URL required (env or .dev.vars).'); process.exit(1); }

const rm = (sen: number | null | undefined) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;

type LineRow = {
  id: string; item_code: string; item_group: string | null;
  qty: number; unit_price_sen: number; total_sen: number; line_cost_sen: number;
  linked_ac_dtlkey: number | null; cancelled: boolean;
};

// Mirror of routes/mfg-sales-orders.ts recomputeTotals, non-sofa path. Returns the
// exact header column set that function writes (minus updated_at, added at write).
function rollup(rows: LineRow[], deliverySen: number) {
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of rows) {
    const lineTotal = it.total_sen || 0, lineCost = it.line_cost_sen || 0;
    total += lineTotal; totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const grandTotal = total + deliverySen;
  const grandMargin = grandTotal - totalCost;
  return {
    mattress_sofa_sen: mattressSofa, bedframe_sen: bedframe, accessories_sen: accessories, others_sen: others,
    service_sen: service, service_cost_sen: serviceCost,
    mattress_sofa_cost_sen: mattressSofaCost, bedframe_cost_sen: bedframeCost,
    accessories_cost_sen: accessoriesCost, others_cost_sen: othersCost,
    local_total_sen: grandTotal, balance_sen: grandTotal, total_cost_sen: totalCost,
    total_revenue_sen: grandTotal, total_margin_sen: grandMargin,
    margin_pct_basis: grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0,
    line_count: rows.length,
  };
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  // Read + validate on a suppressed client (never enqueues on reads).
  const readSb = pgrestShim(pg, 'scm') as any;

  const { data: header, error: hErr } = await readSb.from('mfg_sales_orders')
    .select('doc_no, company_id, status, processing_date, linked_ac_docno, delivery_fee_sen, local_total_sen, service_sen, line_count')
    .eq('doc_no', DOC).maybeSingle();
  if (hErr) throw new Error(`header read failed: ${hErr.message}`);
  if (!header) throw new Error(`${DOC}: not found`);

  const { data: lines, error: lErr } = await readSb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_sen, total_sen, line_cost_sen, linked_ac_dtlkey, cancelled')
    .eq('doc_no', DOC);
  if (lErr) throw new Error(`lines read failed: ${lErr.message}`);
  const all = (lines ?? []) as LineRow[];

  const target = all.find((r) => r.id === LINE_ID);
  if (!target) throw new Error(`line ${LINE_ID} is not on ${DOC}`);
  if (target.item_code !== ITEM_CODE) throw new Error(`line ${LINE_ID} is "${target.item_code}", expected "${ITEM_CODE}" — REFUSING (wrong line guard)`);
  if (target.cancelled) throw new Error('target line is already cancelled — nothing to remove');
  if (!isServiceLine({ itemGroup: target.item_group ?? '', itemCode: target.item_code })) {
    throw new Error(`line "${target.item_code}" (group ${target.item_group}) is not a SERVICE line — this script only removes service/charge lines; use the app amendment for goods lines`);
  }

  // Per-line freeze: refuse if a DO or SI names this exact line.
  const [doRefs, siRefs] = await Promise.all([
    readSb.from('delivery_order_items').select('id').eq('so_item_id', LINE_ID),
    readSb.from('sales_invoice_items').select('id').eq('so_item_id', LINE_ID),
  ]);
  const doN = (doRefs.data ?? []).length, siN = (siRefs.data ?? []).length;
  if (doN > 0 || siN > 0) throw new Error(`line is frozen by downstream (DO refs ${doN}, SI refs ${siN}) — refusing`);

  const remaining = all.filter((r) => r.id !== LINE_ID && !r.cancelled);
  const hasFeeLines = remaining.some((r) => isDeliveryFeeServiceCode(r.item_code));
  const deliverySen = hasFeeLines ? 0 : Number((header as { delivery_fee_sen?: number }).delivery_fee_sen ?? 0);
  const newTotals = rollup(remaining, deliverySen);
  const dtlKey = target.linked_ac_dtlkey;

  const h = header as Record<string, unknown>;
  console.log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN (read + preview, no write)'}`);
  console.log(`SO ${DOC}  status=${h.status}  company=${h.company_id}  linked_ac_docno=${h.linked_ac_docno ?? '(none)'}`);
  console.log(`Remove line: ${target.item_code}  qty ${target.qty} x ${rm(target.unit_price_sen)} = ${rm(target.total_sen)}  (line ${target.id})`);
  console.log(`AutoCount:   ${dtlKey ? `will RETIRE book line DtlKey ${dtlKey}` : 'line carries NO DtlKey — nothing to retire in the book'}`);
  console.log(`Totals:      local_total ${rm(h.local_total_sen as number)} -> ${rm(newTotals.local_total_sen)}   service ${rm(h.service_sen as number)} -> ${rm(newTotals.service_sen)}   lines ${h.line_count} -> ${newTotals.line_count}`);

  if (!apply) {
    console.log('\nDRY-RUN only — nothing written. Re-run with MODE=apply CONFIRM="REMOVE SO LINE" REASON="..." to perform it.');
  } else {
    await pg.begin(async (tx) => {
      const sb = pgrestShim(tx, 'scm', { writeback: 'enqueue' }) as any;
      sb.__atomicCommand = true; // any failure below throws -> transaction rolls back

      // 1) Capture the AutoCount key BEFORE the row (and its DtlKey) are gone.
      const retire = await retiredLineOf(sb, 'mfg_sales_order_items', LINE_ID);
      // 2) Delete the ERP line (pgrestShim has no delete; use the raw tx).
      const del = await tx`delete from scm.mfg_sales_order_items where doc_no = ${DOC} and id = ${LINE_ID}`;
      if (del.count !== 1) throw new Error(`expected to delete 1 row, deleted ${del.count} — rolled back`);
      // 3) Recompute the header totals (mirrors recomputeTotals).
      const { error: updErr } = await sb.from('mfg_sales_orders')
        .update({ ...newTotals, updated_at: new Date().toISOString() }).eq('doc_no', DOC);
      if (updErr) throw new Error(`header recompute failed: ${updErr.message} — rolled back`);
      // 4) Enqueue the AutoCount edit that NAMES the retire (composeSoState builds it).
      const enq = await enqueueEdit(sb, {
        companyId: Number((header as { company_id?: number }).company_id ?? 1),
        docType: 'SO', docNo: DOC, createdBy: null, retire,
      });
      if (enq === false) throw new Error('enqueueEdit returned false (write-back off / no AutoCount counterpart) — rolled back so ERP + book cannot diverge');
      // 5) Audit — the same DELETE_LINE row the route writes, REASON in note.
      await recordSoAudit(sb, {
        docNo: DOC, action: 'DELETE_LINE', actorId: null, actorName: 'Repair: remove SO line',
        source: 'script:remove-so-storage-line', note: REASON,
        fieldChanges: [
          { field: 'itemCode', from: target.item_code },
          { field: 'qty', from: target.qty },
          { field: 'unitPriceSen', from: target.unit_price_sen },
          { field: 'totalSen', from: target.total_sen },
        ],
      });
      console.log(`\nAPPLIED in one transaction: line deleted, header recomputed, AutoCount edit ENQUEUED${dtlKey ? ` (retire DtlKey ${dtlKey})` : ''}, audit written.`);
    });
    console.log('The ~5-min outbox drain will send the edit to AutoCount. Verify the book after the next drain.');
  }
} finally {
  await pg.end({ timeout: 5 });
}
