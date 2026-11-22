/* ----------------------------------------------------------------------------
   so-after-do-lines — the database half of the super-admin "edit SO line items
   after DO" door (owner 2026-11-21, scm/shared/so-after-do-edit.ts). The DEV-70
   price path (so-after-do.ts copyLinePrice*) extended to the QUANTITY and
   SPECIFICATION of a product line, and to ADDING / REMOVING a product line, with
   the one thing a price change never needed: STOCK.

   The move is the same in both directions as the price path:
     SO line  ->  its DO line(s)  ->  the SI line(s) billing those DO lines.
   onto the DO it also re-syncs the shipped stock (the DO's own edit-after-ship
   machinery, injected as `deps` so this lib never imports the DO route), and for
   every live Sales Invoice it re-derives the totals, the paid status and the
   revenue entry exactly as copyLinePriceToInvoices does — issued or not.

   SCOPE (shared/so-after-do-edit.ts): a qty/spec edit and a remove touch a
   product line a SINGLE live DO line carries IN FULL (the whole ordered qty on
   one DO) and, when a qty changes and an invoice bills it, an invoice that bills
   that DO line in full. A split / part-delivered / part-invoiced line is refused
   upstream (AFTER_DO_LINE_NOT_SETTLED) — its right place is each DO, or the
   outstanding part first. A DO with a live Delivery Return is refused too (the
   returned units already moved stock on their own). Everything here stays inside
   one company's predicate (scopeToCompanyId), the only tenant boundary the
   service-role client has.
   -------------------------------------------------------------------------- */

import { scopeToCompanyId } from './companyScope';
import { buildVariantSummary } from '../shared';
import { recomputeDoTotals } from './do-totals';
import { recomputeTotals as recomputeSiTotals } from './si-from-do';
import { recomputeSiPaid } from './si-order-deposit';
import { resyncSiRevenue } from './post-si-revenue';
import { enqueueEdit } from './autocount-outbox';
import { recordEntityAudit, compactChanges, fieldChange, type AuditActor } from './entity-audit';
import { openAfterDo, readDoLinesOfSoLine, type DoLineOfSoLine } from './so-after-do';
import {
  afterDoPriceReturnedRefusal, AFTER_DO_LINE_NOT_SETTLED,
  type AfterDoRefusal, type AfterDoTarget,
} from '../shared/so-after-do-edit';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the SCM libs */
type Db = any;

const live = (s: string | null | undefined): boolean => String(s ?? '').trim().toUpperCase() !== 'CANCELLED';

export type Who = { companyId: number; actor: AuditActor | null; soDocNo: string };

/** The DO stock / cost helpers the DO route owns, injected so this lib never
 *  imports a route module (and so a test can stub them). */
export type AfterDoLineDeps = {
  resyncInventoryForDo: (sb: Db, deliveryOrderId: string, performedBy: string) => Promise<unknown>;
  restampDoActualCost: (sb: Db, deliveryOrderId: string) => Promise<void>;
  performedBy: string;
};

const AFTER_DO_LINE_NOT_ON_DO: AfterDoRefusal = {
  error: 'after_do_line_not_on_do',
  message: 'No open Delivery Order carries this line, so there is nothing to change here.',
};

const AFTER_DO_LINE_SPLIT: AfterDoRefusal = {
  error: 'after_do_split_line',
  message: 'This line is split over more than one Delivery Order line. Change it on each Delivery Order instead.',
};

const downstreamCheckFailed = (what: string): AfterDoRefusal => ({
  error: 'downstream_check_failed',
  message: `Could not read ${what}, so nothing was changed. Try again.`,
});

/** One live Sales Invoice line billing a DO line, with its parent invoice. */
export type SiLineRow = {
  id: string; sales_invoice_id: string; qty: number | null; tax_sen: number | null;
  invoice_number: string | null; invoice_status: string | null;
};

/** The ok shape of the gate, for the route to hold between the gate and the
 *  tail propagation. */
export type OpenProductLineOk = { target: AfterDoTarget; doLine: DoLineOfSoLine; siLines: SiLineRow[]; siQtyOnDoLine: number };

/** The gate every after-DO PRODUCT-line write passes: the permission, a readable
 *  list of the order's live DOs, the ONE live DO line that carries this SO line
 *  (not split, not on a returned DO), and the Sales Invoice coverage of that DO
 *  line. Returns everything the route needs to judge eligibility and propagate. */
export async function openProductLineAfterDo(
  sb: Db, permitted: boolean, docNo: string, soItemId: string, companyId: number,
  forbidden: AfterDoRefusal,
): Promise<
  | ({ ok: true } & OpenProductLineOk)
  | { ok: false; status: 403 | 404 | 409; body: Record<string, unknown> }
> {
  if (!permitted) return { ok: false, status: 403, body: forbidden };
  const open = await openAfterDo(sb, docNo, true, companyId);
  if (!open.ok) return { ok: false, status: open.status, body: open.body };
  const doLines = await readDoLinesOfSoLine(sb, soItemId, companyId, open.targets);
  if (doLines === null) return { ok: false, status: 409, body: downstreamCheckFailed("this order's Delivery Order lines") };
  if (doLines.length === 0) return { ok: false, status: 409, body: AFTER_DO_LINE_NOT_ON_DO };
  if (doLines.length > 1) return { ok: false, status: 409, body: AFTER_DO_LINE_SPLIT };
  const doLine = doLines[0];
  const target = open.targets.find((t) => t.id === doLine.delivery_order_id);
  if (!target) return { ok: false, status: 409, body: AFTER_DO_LINE_NOT_ON_DO };
  // A Delivery Return already moved stock on its own — never layer a resync on it.
  if (target.returned) return { ok: false, status: 409, body: afterDoPriceReturnedRefusal([target.do_number ?? target.id]) };

  // Sales Invoice coverage of THIS DO line — the lines, and how much qty they bill.
  const { data: siItems, error: siErr } = await scopeToCompanyId(
    sb.from('sales_invoice_items').select('id, sales_invoice_id, qty, tax_sen').eq('do_item_id', doLine.id), companyId,
  );
  if (siErr) return { ok: false, status: 409, body: downstreamCheckFailed("this order's Sales Invoice lines") };
  const items = ((siItems ?? []) as Array<{ id: string; sales_invoice_id: string; qty: number | null; tax_sen: number | null }>);
  let siLines: SiLineRow[] = [];
  let siQtyOnDoLine = 0;
  if (items.length > 0) {
    const { data: heads, error: headErr } = await scopeToCompanyId(
      sb.from('sales_invoices').select('id, invoice_number, status').in('id', [...new Set(items.map((l) => l.sales_invoice_id))]), companyId,
    );
    if (headErr) return { ok: false, status: 409, body: downstreamCheckFailed("this order's Sales Invoices") };
    const byId = new Map(((heads ?? []) as Array<{ id: string; invoice_number: string | null; status: string | null }>).map((h) => [h.id, h]));
    siLines = items
      .map((l) => ({ ...l, head: byId.get(l.sales_invoice_id) }))
      .filter((l) => l.head && live(l.head.status))
      .map((l) => ({ id: l.id, sales_invoice_id: l.sales_invoice_id, qty: l.qty, tax_sen: l.tax_sen, invoice_number: l.head!.invoice_number, invoice_status: l.head!.status }));
    siQtyOnDoLine = siLines.reduce((s, l) => s + Number(l.qty ?? 0), 0);
  }
  return { ok: true, target, doLine, siLines, siQtyOnDoLine };
}

/** A qty change is only unambiguous when the single DO line carries the WHOLE
 *  ordered qty, at most one invoice line bills it, and (if billed) it bills that
 *  DO line in full. More than one invoice line would each take the new qty and
 *  double-count, so that is refused too. */
export function afterDoQtyChangeAllowed(prevSoQty: number, doLineQty: number, siQtyOnDoLine: number, siLineCount: number): boolean {
  if (doLineQty !== prevSoQty) return false; // part-delivered: the DO holds fewer than the order
  if (siLineCount > 1) return false; // billed across more than one invoice line
  if (siQtyOnDoLine > 0 && siQtyOnDoLine !== doLineQty) return false; // part-invoiced
  return true;
}

export { AFTER_DO_LINE_NOT_SETTLED };

const SO_LINE_READ =
  'item_code, item_group, description, description2, uom, qty, unit_price_sen, discount_sen, unit_cost_sen, variants, ' +
  'remark, line_delivery_date, line_delivery_date_overridden, gap_inches, divan_height_inches, divan_price_sen, ' +
  'leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, m3_milli';

export type SoLineShape = Record<string, unknown> & {
  item_code: string | null; item_group: string | null; description: string | null; description2: string | null;
  uom: string | null; qty: number | null; unit_price_sen: number | null; discount_sen: number | null;
  unit_cost_sen: number | null; variants: Record<string, unknown> | null;
};

/** The product/qty/price fields of a DO line, mirrored from an SO line. Leaves
 *  the ship-provenance columns (committed_po_batch_no, rack_id, photo_urls)
 *  alone — the resync re-derives the stock against them. */
export function doLinePatchFromSoLine(l: SoLineShape): Record<string, unknown> {
  const qty = Number(l.qty ?? 0), unit = Number(l.unit_price_sen ?? 0), disc = Number(l.discount_sen ?? 0), cost = Number(l.unit_cost_sen ?? 0);
  const lineTotal = Math.max(0, qty * unit - disc);
  const lineCost = qty * cost;
  const group = String(l.item_group ?? '');
  return {
    item_code: l.item_code, item_group: l.item_group,
    description: l.description ?? null,
    description2: buildVariantSummary(group, l.variants ?? null) || (l.description2 as string | null) || null,
    uom: l.uom ?? 'UNIT',
    qty, unit_price_sen: unit, discount_sen: disc, line_total_sen: lineTotal,
    unit_cost_sen: cost, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
    variants: l.variants ?? null,
    gap_inches: (l.gap_inches as number | null) ?? null,
    divan_height_inches: (l.divan_height_inches as number | null) ?? null,
    divan_price_sen: Number(l.divan_price_sen ?? 0),
    leg_height_inches: (l.leg_height_inches as number | null) ?? null,
    leg_price_sen: Number(l.leg_price_sen ?? 0),
    custom_specials: (l.custom_specials as unknown) ?? null,
    line_suffix: (l.line_suffix as string | null) ?? null,
    special_order_price_sen: Number(l.special_order_price_sen ?? 0),
    // NOT mirrored: notes, m3_milli, line_delivery_date(_overridden) — those are
    // the DO line's own (delivery note, cubic volume, delivery day); an SO line
    // qty/spec edit must not reach across and blank them.
  };
}

/** Re-derive one live invoice billing the changed DO line: its billed lines take
 *  the new spec / price / (settled) qty and the delivered cost, then the invoice
 *  is re-totalled, its paid status re-rolled, its revenue entry voided and
 *  re-posted at the new total, and the AutoCount invoice edit queued — the exact
 *  sequence copyLinePriceToInvoices uses, now carrying qty and spec too. */
async function reDeriveInvoiceLines(
  sb: Db, who: Who, h: { id: string; invoice_number: string | null; status: string | null },
  lineIds: ReadonlyArray<string>, patch: Record<string, unknown>, setQty: number | null,
): Promise<boolean> {
  let ok = true;
  const changes: Array<ReturnType<typeof fieldChange>> = [];
  for (const id of lineIds) {
    const { data: prev, error: prevErr } = await scopeToCompanyId(
      sb.from('sales_invoice_items').select('qty, unit_price_sen, discount_sen, tax_sen, unit_cost_sen, item_code').eq('id', id), who.companyId,
    ).maybeSingle();
    if (prevErr || !prev) { ok = false; continue; }
    const p = prev as { qty: number | null; unit_price_sen: number | null; discount_sen: number | null; tax_sen: number | null; unit_cost_sen: number | null; item_code: string | null };
    const qty = setQty != null ? setQty : Number(p.qty ?? 0);
    const unit = Number(patch.unit_price_sen ?? 0), disc = Number(patch.discount_sen ?? 0), cost = Number(patch.unit_cost_sen ?? 0);
    const tax = Number(p.tax_sen ?? 0);
    const lineTotal = Math.max(0, qty * unit - disc + tax);
    const { error: upErr } = await scopeToCompanyId(
      sb.from('sales_invoice_items').update({
        item_code: patch.item_code, item_group: patch.item_group, description: patch.description, description2: patch.description2,
        uom: patch.uom, variants: patch.variants, qty,
        unit_price_sen: unit, discount_sen: disc, unit_cost_sen: cost,
        line_total_sen: lineTotal, line_cost_sen: qty * cost, line_margin_sen: lineTotal - qty * cost,
      }).eq('id', id), who.companyId,
    );
    if (upErr) { ok = false; continue; }
    changes.push(fieldChange('itemCode', p.item_code ?? null, patch.item_code ?? null), fieldChange('qty', p.qty ?? null, qty), fieldChange('unitPriceSen', p.unit_price_sen ?? null, unit));
  }
  await recomputeSiTotals(sb, h.id);
  await recomputeSiPaid(sb, h.id);
  if (h.invoice_number) {
    try { await resyncSiRevenue(sb, h.invoice_number); }
    catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] edit-after-DO resync failed:', e); }
  }
  await recordEntityAudit(sb, {
    entityType: 'SALES_INVOICE', entityId: h.id, entityDocNo: h.invoice_number, action: 'UPDATE',
    actor: who.actor, companyId: who.companyId, statusSnapshot: h.status,
    note: `Line changed from ${who.soDocNo} (edit line after DO): ${String(patch.item_code ?? '')}`,
    fieldChanges: compactChanges(changes),
  });
  await enqueueEdit(sb, { companyId: who.companyId, docType: 'IV', docId: h.id, newLineIds: [], createdBy: who.actor?.id ?? null });
  return ok;
}

/** EDIT — after the SO line's own PATCH committed its new qty / spec / price,
 *  mirror it onto the one DO line that carries it, re-sync the shipped stock,
 *  re-stamp the delivered cost, re-total the DO, then re-derive every live
 *  invoice billing it. `setSiQty` is the new qty when a qty change was allowed
 *  (the route proved the DO line and invoice carry the whole line), else null to
 *  leave invoice quantities untouched (a spec/price-only change). */
export async function propagateLineEditAfterDo(
  sb: Db, who: Who,
  args: { soItemId: string; doLine: DoLineOfSoLine; target: AfterDoTarget; siLines: ReadonlyArray<SiLineRow>; setSiQty: number | null; deps: AfterDoLineDeps },
): Promise<{ doCopyFailed: string[]; siCopyFailed: string[] }> {
  const { soItemId, doLine, target, siLines, setSiQty, deps } = args;
  const doCopyFailed: string[] = [];
  const siCopyFailed: string[] = [];
  const label = target.do_number ?? target.id;

  const { data: so, error: soErr } = await scopeToCompanyId(
    sb.from('mfg_sales_order_items').select(SO_LINE_READ).eq('id', soItemId), who.companyId,
  ).maybeSingle();
  if (soErr || !so) return { doCopyFailed: [label], siCopyFailed: siLines.length ? ['(invoice unchanged)'] : [] };
  const soLine = so as SoLineShape;

  const { data: beforeDo } = await scopeToCompanyId(
    sb.from('delivery_order_items').select('item_code, qty, unit_price_sen, discount_sen').eq('id', doLine.id), who.companyId,
  ).maybeSingle();
  const patch = doLinePatchFromSoLine(soLine);
  const { error: doErr } = await scopeToCompanyId(
    sb.from('delivery_order_items').update(patch).eq('id', doLine.id), who.companyId,
  );
  if (doErr) { doCopyFailed.push(label); return { doCopyFailed, siCopyFailed }; }

  // Stock OUT/IN correction (qty delta, or old-bucket return + new-bucket ship on
  // a spec change), then the delivered cost re-stamp — the DO's own machinery.
  await deps.resyncInventoryForDo(sb, target.id, deps.performedBy);
  await deps.restampDoActualCost(sb, target.id);
  await recomputeDoTotals(sb, target.id);
  const bp = (beforeDo ?? {}) as Record<string, unknown>;
  await recordEntityAudit(sb, {
    entityType: 'DELIVERY_ORDER', entityId: target.id, entityDocNo: target.do_number, action: 'UPDATE',
    actor: who.actor, companyId: who.companyId, statusSnapshot: target.status,
    note: `Line changed from ${who.soDocNo} (edit line after DO): ${String(soLine.item_code ?? '')}`,
    fieldChanges: compactChanges([
      fieldChange('itemCode', bp.item_code ?? null, patch.item_code ?? null),
      fieldChange('qty', bp.qty ?? null, patch.qty),
      fieldChange('unitPriceSen', bp.unit_price_sen ?? null, patch.unit_price_sen),
    ]),
  });
  await enqueueEdit(sb, { companyId: who.companyId, docType: 'DO', docId: target.id, newLineIds: [], createdBy: who.actor?.id ?? null });

  if (siLines.length === 0) return { doCopyFailed, siCopyFailed };
  // The delivered cost the resync/restamp just settled onto the DO line is what
  // the invoice must carry (a spec change moved the cost basis).
  const { data: costRow } = await scopeToCompanyId(
    sb.from('delivery_order_items').select('unit_cost_sen').eq('id', doLine.id), who.companyId,
  ).maybeSingle();
  const siPatch = { ...patch, unit_cost_sen: Number((costRow as { unit_cost_sen?: number | null } | null)?.unit_cost_sen ?? patch.unit_cost_sen ?? 0) };
  const byInvoice = new Map<string, { head: SiLineRow; ids: string[] }>();
  for (const l of siLines) {
    const g = byInvoice.get(l.sales_invoice_id) ?? { head: l, ids: [] };
    g.ids.push(l.id); byInvoice.set(l.sales_invoice_id, g);
  }
  for (const { head, ids } of byInvoice.values()) {
    const ok = await reDeriveInvoiceLines(sb, who,
      { id: head.sales_invoice_id, invoice_number: head.invoice_number, status: head.invoice_status },
      ids, siPatch, setSiQty);
    if (!ok) siCopyFailed.push(head.invoice_number ?? head.sales_invoice_id);
  }
  return { doCopyFailed, siCopyFailed };
}
