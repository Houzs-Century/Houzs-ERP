/* ----------------------------------------------------------------------------
   so-after-do — the database half of shared/so-after-do-edit.ts (DEV-32): which
   live Delivery Orders carry a Sales Order, and the copies an after-DO edit
   writes onto them. Every DO write here re-totals the DO, records it on the DO's
   own history and queues the DO's AutoCount edit — the three things the DO's own
   line and header routes do after a change.
   -------------------------------------------------------------------------- */

import { chunkIn } from './paginate-all';
import { scopeToCompanyId } from './companyScope';
import { buildDoItemRow } from './do-item-row';
import { recomputeDoTotals } from './do-totals';
import { coerceEmptyDates } from './date-coerce';
import { enqueueEdit } from './autocount-outbox';
import { recordEntityAudit, compactChanges, fieldChange, type AuditActor } from './entity-audit';
import { normalizePhone } from '../shared/phone';
import { isServiceCategory } from '../shared/service-sku';
import { AFTER_DO_FORBIDDEN, AFTER_DO_NO_DO, doHeaderPatchFromSo, type AfterDoTarget } from '../shared/so-after-do-edit';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the SCM libs */
type Db = any;

const live = (s: string | null | undefined): boolean => String(s ?? '').trim().toUpperCase() !== 'CANCELLED';

export type AfterDoRead =
  | { ok: true; targets: AfterDoTarget[]; invoicedWithoutDo: boolean }
  | { ok: false; reason: string };

/** The live Delivery Orders carrying this order (by header or by line), each
 *  marked `locked` when a live Sales Invoice or Delivery Return hangs off it —
 *  the same test as the DO routes' doHasDownstream. A failed read is a refusal,
 *  never an empty list: an empty list is what lets the write through. */
export async function readAfterDoTargets(sb: Db, docNo: string, companyId: number): Promise<AfterDoRead> {
  const [linesRes, ownDosRes, sisRes] = await Promise.all([
    scopeToCompanyId(sb.from('mfg_sales_order_items').select('id').eq('doc_no', docNo), companyId),
    scopeToCompanyId(sb.from('delivery_orders').select('id').eq('so_doc_no', docNo), companyId),
    scopeToCompanyId(sb.from('sales_invoices').select('id, status, delivery_order_id').eq('so_doc_no', docNo), companyId),
  ]);
  if (linesRes.error) return { ok: false, reason: `mfg_sales_order_items: ${linesRes.error.message}` };
  if (ownDosRes.error) return { ok: false, reason: `delivery_orders: ${ownDosRes.error.message}` };
  if (sisRes.error) return { ok: false, reason: `sales_invoices: ${sisRes.error.message}` };
  const lineIds = ((linesRes.data ?? []) as Array<{ id: string }>).map((l) => l.id);
  const invoicedWithoutDo = ((sisRes.data ?? []) as Array<{ status: string | null; delivery_order_id: string | null }>)
    .some((s) => live(s.status) && !s.delivery_order_id);

  const byLine = await chunkIn<{ delivery_order_id: string }>(lineIds, (batch, from, to) =>
    sb.from('delivery_order_items').select('delivery_order_id').in('so_item_id', batch).range(from, to));
  if (byLine.error) return { ok: false, reason: `delivery_order_items: ${byLine.error.message}` };
  const ids = [...new Set([
    ...((ownDosRes.data ?? []) as Array<{ id: string }>).map((d) => d.id),
    ...byLine.data.map((l) => l.delivery_order_id),
  ].filter(Boolean))];
  if (ids.length === 0) return { ok: true, targets: [], invoicedWithoutDo };

  type Child = { delivery_order_id: string | null; status: string | null };
  const [heads, sis, drs] = await Promise.all([
    chunkIn<{ id: string; do_number: string | null; status: string | null }>(ids, (batch, from, to) =>
      scopeToCompanyId(sb.from('delivery_orders').select('id, do_number, status').in('id', batch), companyId).range(from, to)),
    chunkIn<Child>(ids, (batch, from, to) =>
      sb.from('sales_invoices').select('delivery_order_id, status').in('delivery_order_id', batch).range(from, to)),
    chunkIn<Child>(ids, (batch, from, to) =>
      sb.from('delivery_returns').select('delivery_order_id, status').in('delivery_order_id', batch).range(from, to)),
  ]);
  if (heads.error) return { ok: false, reason: `delivery_orders: ${heads.error.message}` };
  if (sis.error) return { ok: false, reason: `sales_invoices: ${sis.error.message}` };
  if (drs.error) return { ok: false, reason: `delivery_returns: ${drs.error.message}` };
  const locked = new Set([...sis.data, ...drs.data].filter((r) => live(r.status)).map((r) => r.delivery_order_id));
  const targets = heads.data
    .filter((h) => live(h.status))
    .sort((a, b) => String(a.do_number ?? '').localeCompare(String(b.do_number ?? '')))
    .map((h) => ({ id: h.id, do_number: h.do_number ?? null, status: h.status ?? null, locked: locked.has(h.id) }));
  return { ok: true, targets, invoicedWithoutDo };
}

export type AfterDoOpen =
  | { ok: true; targets: AfterDoTarget[]; invoicedWithoutDo: boolean }
  | { ok: false; status: 403 | 409; body: Record<string, unknown> };

/** The gate every after-DO write passes first: the permission, then a readable
 *  list of the order's live DOs, of which there must be at least one. */
export async function openAfterDo(sb: Db, docNo: string, permitted: boolean, companyId: number): Promise<AfterDoOpen> {
  if (!permitted) return { ok: false, status: 403, body: AFTER_DO_FORBIDDEN };
  const read = await readAfterDoTargets(sb, docNo, companyId);
  if (!read.ok) {
    return { ok: false, status: 409, body: { error: 'downstream_check_failed', message: `Could not read this order's Delivery Orders, so nothing was changed. Try again (${read.reason}).` } };
  }
  if (read.targets.length === 0) return { ok: false, status: 409, body: AFTER_DO_NO_DO };
  return { ok: true, targets: read.targets, invoicedWithoutDo: read.invoicedWithoutDo };
}

/** The catalog's word on whether a code is a charge (SERVICE) SKU. The client's
 *  item_group is not trusted for this: it decides what the permission unlocks. */
export async function catalogSaysService(sb: Db, itemCode: string, companyId: number): Promise<boolean | null> {
  const { data, error } = await scopeToCompanyId(
    sb.from('mfg_products').select('category').eq('code', itemCode), companyId,
  ).maybeSingle();
  if (error) return null;
  return isServiceCategory((data as { category?: string | null } | null)?.category ?? null);
}

type Who = { companyId: number; actor: AuditActor | null; soDocNo: string };

const queueDoEdit = (sb: Db, who: Who, doId: string, newLineIds: string[] = []) =>
  enqueueEdit(sb, { companyId: who.companyId, docType: 'DO', docId: doId, newLineIds, createdBy: who.actor?.id ?? null });

/** Copy the SAVED order's customer details onto each target DO. Returns the DO
 *  numbers whose write failed, so the route can say so instead of claiming both
 *  documents agree. */
export async function copyCustomerDetailsToDos(
  sb: Db,
  who: Who,
  soRow: Record<string, unknown>,
  changedCols: ReadonlyArray<string>,
  targets: ReadonlyArray<AfterDoTarget>,
): Promise<string[]> {
  const patch = doHeaderPatchFromSo(soRow, changedCols);
  for (const col of ['phone', 'emergency_contact_phone']) {
    if (typeof patch[col] === 'string') patch[col] = normalizePhone(patch[col] as string) ?? patch[col];
  }
  coerceEmptyDates(patch);
  const cols = Object.keys(patch);
  if (cols.length === 0) return [];
  const failed: string[] = [];
  for (const t of targets) {
    const { data: before, error: beforeErr } = await scopeToCompanyId(
      sb.from('delivery_orders').select(cols.join(', ')).eq('id', t.id), who.companyId,
    ).maybeSingle();
    if (beforeErr) { failed.push(t.do_number ?? t.id); continue; } // no history row without its from-values
    const { error } = await scopeToCompanyId(
      sb.from('delivery_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', t.id), who.companyId,
    );
    if (error) { failed.push(t.do_number ?? t.id); continue; }
    const prev = (before ?? {}) as Record<string, unknown>;
    await recordEntityAudit(sb, {
      entityType: 'DELIVERY_ORDER', entityId: t.id, entityDocNo: t.do_number, action: 'UPDATE',
      actor: who.actor, companyId: who.companyId, statusSnapshot: t.status,
      note: `Customer details copied from ${who.soDocNo} (edit after DO)`,
      fieldChanges: compactChanges(cols.map((col) => fieldChange(col, prev[col] ?? null, patch[col] ?? null))),
    });
    await queueDoEdit(sb, who, t.id);
  }
  return failed;
}

const SO_LINE_COLS = 'id, item_code, item_group, description, description2, uom, qty, unit_price_sen, discount_sen, unit_cost_sen, variants, remark, line_delivery_date';

/** Put a just-added SO charge line onto the target DO. */
export async function addChargeLineToDo(
  sb: Db,
  who: Who,
  soItemId: string,
  target: AfterDoTarget,
): Promise<{ ok: true; doItemId: string } | { ok: false; reason: string }> {
  const { data: so, error: soErr } = await scopeToCompanyId(
    sb.from('mfg_sales_order_items').select(SO_LINE_COLS).eq('id', soItemId), who.companyId,
  ).maybeSingle();
  if (soErr || !so) return { ok: false, reason: soErr?.message ?? 'sales order line not found' };
  const l = so as Record<string, unknown>;
  const { data: maxNoRow, error: maxNoErr } = await sb.from('delivery_order_items').select('line_no')
    .eq('delivery_order_id', target.id).order('line_no', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (maxNoErr) return { ok: false, reason: `delivery_order_items: ${maxNoErr.message}` };
  const maxNo = (maxNoRow as { line_no?: number | null } | null)?.line_no;
  const row = buildDoItemRow(target.id, {
    itemCode: l.item_code, itemGroup: l.item_group, description: l.description, description2: l.description2,
    uom: l.uom, qty: l.qty, unitPriceSen: l.unit_price_sen, discountSen: l.discount_sen, unitCostSen: l.unit_cost_sen,
    variants: l.variants, notes: l.remark, lineDeliveryDate: l.line_delivery_date, soItemId,
  }, typeof maxNo === 'number' ? maxNo + 1 : null, null, new Map());
  const { data: ins, error } = await sb.from('delivery_order_items')
    .insert({ ...row, company_id: who.companyId }).select('id').single();
  if (error || !ins) return { ok: false, reason: error?.message ?? 'insert failed' };
  const doItemId = String((ins as { id: string }).id);
  await recomputeDoTotals(sb, target.id);
  await recordEntityAudit(sb, {
    entityType: 'DELIVERY_ORDER', entityId: target.id, entityDocNo: target.do_number, action: 'UPDATE',
    actor: who.actor, companyId: who.companyId, statusSnapshot: target.status,
    note: `Line added from ${who.soDocNo} (edit after DO): ${String(l.item_code ?? '')}`,
    fieldChanges: compactChanges([
      fieldChange('itemCode', null, row.item_code ?? null),
      fieldChange('qty', null, row.qty),
      fieldChange('unitPriceSen', null, row.unit_price_sen),
      fieldChange('lineTotalSen', null, row.line_total_sen),
    ]),
  });
  await queueDoEdit(sb, who, target.id, [doItemId]);
  return { ok: true, doItemId };
}

export type DoLineOfSoLine = { id: string; delivery_order_id: string; qty: number };

/** The DO lines that carry one SO line, on live DOs only. */
export async function readDoLinesOfSoLine(sb: Db, soItemId: string, companyId: number, targets: ReadonlyArray<AfterDoTarget>): Promise<DoLineOfSoLine[] | null> {
  const { data, error } = await scopeToCompanyId(
    sb.from('delivery_order_items').select('id, delivery_order_id, qty').eq('so_item_id', soItemId), companyId,
  );
  if (error) return null;
  const liveIds = new Set(targets.map((t) => t.id));
  return ((data ?? []) as DoLineOfSoLine[]).filter((r) => liveIds.has(r.delivery_order_id));
}

/** After the SO charge line saved, make its one DO line say the same. */
export async function copyChargeLineToDo(
  sb: Db,
  who: Who,
  soItemId: string,
  doLine: DoLineOfSoLine,
  target: AfterDoTarget,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [{ data: so, error: soErr }, { data: prev, error: prevErr }] = await Promise.all([
    scopeToCompanyId(sb.from('mfg_sales_order_items').select(SO_LINE_COLS).eq('id', soItemId), who.companyId).maybeSingle(),
    scopeToCompanyId(sb.from('delivery_order_items').select('qty, unit_price_sen, discount_sen, description').eq('id', doLine.id), who.companyId).maybeSingle(),
  ]);
  if (soErr || !so) return { ok: false, reason: soErr?.message ?? 'sales order line not found' };
  if (prevErr) return { ok: false, reason: `delivery_order_items: ${prevErr.message}` };
  const l = so as Record<string, unknown>;
  const qty = Number(l.qty ?? 0), unit = Number(l.unit_price_sen ?? 0), disc = Number(l.discount_sen ?? 0), cost = Number(l.unit_cost_sen ?? 0);
  const lineTotal = Math.max(0, qty * unit - disc), lineCost = qty * cost;
  const patch = {
    qty, unit_price_sen: unit, discount_sen: disc, unit_cost_sen: cost,
    line_total_sen: lineTotal, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
    description: (l.description as string | null) ?? null,
  };
  const { error } = await scopeToCompanyId(sb.from('delivery_order_items').update(patch).eq('id', doLine.id), who.companyId);
  if (error) return { ok: false, reason: error.message };
  await recomputeDoTotals(sb, target.id);
  const p = (prev ?? {}) as Record<string, unknown>;
  await recordEntityAudit(sb, {
    entityType: 'DELIVERY_ORDER', entityId: target.id, entityDocNo: target.do_number, action: 'UPDATE',
    actor: who.actor, companyId: who.companyId, statusSnapshot: target.status,
    note: `Line updated from ${who.soDocNo} (edit after DO): ${String(l.item_code ?? '')}`,
    fieldChanges: compactChanges([
      fieldChange('qty', p.qty ?? null, qty),
      fieldChange('unitPriceSen', p.unit_price_sen ?? null, unit),
      fieldChange('discountSen', p.discount_sen ?? null, disc),
      fieldChange('description', p.description ?? null, patch.description),
    ]),
  });
  await queueDoEdit(sb, who, target.id);
  return { ok: true };
}
