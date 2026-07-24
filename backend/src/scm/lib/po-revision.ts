// ----------------------------------------------------------------------------
// po-revision.ts — the Approve engine for a PURCHASE ORDER amendment.
//
// Sibling of so-revision.ts's reviseBoundPo, but simpler and self-directed: a PO
// amendment is authored directly against a Purchase Order (not derived from a
// revised SO), so applyPoAmendment applies the operator's requested line + header
// diffs to the PO IN PLACE. It does NOT re-run honest selling-price pricing — a
// PO carries the supplier COST the purchaser negotiated, so the amendment's
// new_unit_price_centi is authoritative and is written through as given.
//
// On approve, for the ONE bound PO the amendment targets:
//   • snapshot the CURRENT PO into scm.po_revisions (reusing snapshotPo from
//     so-revision.ts — the immutable version being replaced),
//   • apply the header diffs (supplier / delivery / notes),
//   • apply the line diffs (SPEC / QTY / PRICE / DELIVERY / ADD / REMOVE),
//   • recompute the PO subtotal + total + expected_at from the live line set,
//   • bump purchase_orders.revision to the snapshot's next number,
//   • write ONE AMENDMENT_PO_APPROVED row to scm.entity_audit_log.
//
// Received floor (mirror of reviseBoundPo): a SURVIVING line whose revised qty
// would drop below its already-received_qty ABORTS the whole apply before any
// write (ReceivedFloorError). A REMOVE of an already-received line is PRESERVED
// and warned, never silently deleted — goods already in are not ours to discard.
//
// Idempotency: snapshotPo upserts on (po_id, revision); an approve runs once
// (the route's status gate + apply-lease prevent a second), but a retry after a
// mid-apply failure re-snapshots the same revision as a no-op.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import { snapshotPo, ReceivedFloorError } from './so-revision';
import { recordEntityAudit } from './entity-audit';
import { poReceivedFloorViolation } from '../shared/po-amendment';

// The same structural client shape so-revision.ts + the fake-sb test use.
type Sb = { from: (t: string) => any };

export { ReceivedFloorError };

type PoAmendmentLine = {
  id: string;
  purchase_order_item_id: string | null;
  change_type: string;
  new_material_code: string | null;
  new_material_name: string | null;
  new_variants: Record<string, unknown> | null;
  new_qty: number | null;
  new_unit_price_centi: number | null;
  new_delivery_date: string | null;
  old_snapshot: Record<string, unknown> | null;
};

export type ApplyPoAmendmentResult = {
  poId: string;
  poNumber: string;
  revision: number;
  linesUpdated: number;
  linesAdded: number;
  linesRemoved: number;
  /* Plain-language notes for the operator about anything left for a human hand —
     a removed line preserved because it was already received, or a PO left with
     no lines at all. */
  warnings: string[];
};

const centi = (v: unknown): number => Number(v ?? 0);

/** Recompute a PO line's total from its qty / unit price / discount, clamped >= 0. */
function lineTotal(qty: number, unitPriceCenti: number, discountCenti: number): number {
  return Math.max(0, qty * unitPriceCenti - discountCenti);
}

export async function applyPoAmendment(
  sb: Sb,
  amendmentId: string,
  userId: string | null,
  c?: Context<any>,
): Promise<ApplyPoAmendmentResult> {
  // (1) Load amendment + its lines + the PO header it targets.
  const { data: amdRow, error: amdErr } = await sb
    .from('po_amendments')
    .select('id, po_id, po_number, header_changes, old_header_snapshot')
    .eq('id', amendmentId)
    .maybeSingle();
  if (amdErr) throw new Error(`applyPoAmendment: amendment load failed: ${amdErr.message}`);
  if (!amdRow) throw new Error('applyPoAmendment: amendment not found');
  const poId = String(amdRow.po_id);
  const poNumber = String(amdRow.po_number);
  const headerChanges = (amdRow.header_changes ?? null) as Record<string, unknown> | null;

  const { data: lineRows, error: lineErr } = await sb
    .from('po_amendment_lines')
    .select('id, purchase_order_item_id, change_type, new_material_code, new_material_name, ' +
      'new_variants, new_qty, new_unit_price_centi, new_delivery_date, old_snapshot')
    .eq('amendment_id', amendmentId);
  if (lineErr) throw new Error(`applyPoAmendment: amendment lines load failed: ${lineErr.message}`);
  const amendmentLines = (lineRows ?? []) as PoAmendmentLine[];

  const { data: poHeader, error: poErr } = await sb
    .from('purchase_orders')
    .select('id, po_number, supplier_id, expected_at, notes, tax_centi, revision, company_id')
    .eq('id', poId)
    .maybeSingle();
  if (poErr) throw new Error(`applyPoAmendment: PO header load failed: ${poErr.message}`);
  if (!poHeader) throw new Error(`applyPoAmendment: PO ${poId} not found`);
  const companyId = (poHeader as { company_id?: number | null }).company_id ?? null;

  // (2) Received floor — check EVERY surviving in-place line BEFORE any write, so
  //     a violation aborts cleanly with nothing changed (mirror reviseBoundPo).
  for (const diff of amendmentLines) {
    const change = String(diff.change_type ?? '').toUpperCase();
    if (change === 'ADD' || change === 'REMOVE') continue;
    if (diff.new_qty == null || !diff.purchase_order_item_id) continue;
    const { data: existing, error: exErr } = await sb
      .from('purchase_order_items')
      .select('id, received_qty')
      .eq('id', diff.purchase_order_item_id)
      .maybeSingle();
    if (exErr) throw new Error(`applyPoAmendment: received-floor load failed: ${exErr.message}`);
    if (!existing) continue;
    const received = centi((existing as { received_qty?: number }).received_qty);
    if (poReceivedFloorViolation({ newQty: Number(diff.new_qty) }, { receivedQty: received })) {
      throw new ReceivedFloorError(String(diff.purchase_order_item_id), Number(diff.new_qty), received);
    }
  }

  // (3) Snapshot the CURRENT PO before touching a line. Returns the next revision.
  const nextRevision = await snapshotPo(sb, poId, amendmentId, userId, c);

  // (4) Header diffs — supplier / delivery date / notes, applied as given.
  const headerFieldChanges: Array<{ field: string; from: unknown; to: unknown }> = [];
  let expectedAtOverridden = false;
  if (headerChanges && Object.keys(headerChanges).length > 0) {
    const before = (amdRow.old_header_snapshot ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ['supplier_id', 'expected_at', 'notes'] as const) {
      if (headerChanges[key] === undefined) continue;
      patch[key] = headerChanges[key];
      headerFieldChanges.push({ field: key, from: before[key] ?? null, to: headerChanges[key] ?? null });
      if (key === 'expected_at') expectedAtOverridden = true;
    }
    if (Object.keys(patch).length > 0) {
      const { error: hErr } = await sb.from('purchase_orders').update(patch).eq('id', poId);
      if (hErr) throw new Error(`applyPoAmendment: header update failed: ${hErr.message}`);
    }
  }

  // (5) Line diffs.
  let linesUpdated = 0, linesAdded = 0, linesRemoved = 0;
  const warnings: string[] = [];
  const lineFieldChanges: Array<{ field: string; from: unknown; to: unknown }> = [];

  for (const diff of amendmentLines) {
    const change = String(diff.change_type ?? '').toUpperCase();

    if (change === 'REMOVE') {
      if (!diff.purchase_order_item_id) continue;
      const { data: existing, error: exErr } = await sb
        .from('purchase_order_items')
        .select('id, received_qty, material_name, material_code')
        .eq('id', diff.purchase_order_item_id)
        .maybeSingle();
      if (exErr) throw new Error(`applyPoAmendment: REMOVE load failed: ${exErr.message}`);
      if (!existing) continue; // already gone — nothing to remove
      const row = existing as { received_qty?: number; material_name?: string; material_code?: string };
      if (centi(row.received_qty) > 0) {
        // Already (partly) received — preserve it and surface for manual handling.
        warnings.push(
          `The line for ${row.material_name || row.material_code || 'an item'} on purchase order ${poNumber} `
          + `was already received, so it was kept on the order instead of being removed. Handle it by hand.`,
        );
        continue;
      }
      const { error: delErr } = await sb
        .from('purchase_order_items')
        .delete()
        .eq('id', diff.purchase_order_item_id);
      if (delErr) throw new Error(`applyPoAmendment: REMOVE delete failed: ${delErr.message}`);
      lineFieldChanges.push({
        field: `line_removed_${row.material_code ?? diff.purchase_order_item_id}`,
        from: `qty ${(diff.old_snapshot?.qty as number | undefined) ?? '?'}`, to: 'removed',
      });
      linesRemoved++;
      continue;
    }

    if (change === 'ADD') {
      const materialCode = String(diff.new_material_code ?? '').trim();
      if (!materialCode) throw new Error('applyPoAmendment: ADD line has no new_material_code');
      const qty = Math.max(1, Number(diff.new_qty ?? 1));
      const unit = centi(diff.new_unit_price_centi);
      const { error: insErr } = await sb.from('purchase_order_items').insert({
        ...(companyId != null ? { company_id: companyId } : {}),
        purchase_order_id: poId,
        material_kind:     String((diff.new_variants?.materialKind as string | undefined) ?? 'mfg_product'),
        material_code:     materialCode,
        material_name:     diff.new_material_name ?? materialCode,
        qty,
        unit_price_centi:  unit,
        discount_centi:    0,
        line_total_centi:  lineTotal(qty, unit, 0),
        unit_cost_centi:   unit,
        received_qty:      0,
        variants:          diff.new_variants ?? null,
        item_group:        String((diff.new_variants?.itemGroup as string | undefined) ?? 'others'),
        uom:               'UNIT',
        delivery_date:     diff.new_delivery_date ?? null,
        from_mrp:          false,
      });
      if (insErr) throw new Error(`applyPoAmendment: ADD insert failed: ${insErr.message}`);
      lineFieldChanges.push({ field: `line_added_${materialCode}`, from: null, to: `qty ${qty}` });
      linesAdded++;
      continue;
    }

    // SPEC / QTY / PRICE / DELIVERY — mutate an existing line in place.
    if (!diff.purchase_order_item_id) continue;
    const { data: existing, error: exErr } = await sb
      .from('purchase_order_items')
      .select('id, qty, unit_price_centi, discount_centi, material_code, material_name, variants, delivery_date')
      .eq('id', diff.purchase_order_item_id)
      .maybeSingle();
    if (exErr) throw new Error(`applyPoAmendment: line load failed: ${exErr.message}`);
    if (!existing) continue; // line already gone
    const row = existing as Record<string, unknown>;

    const qty = diff.new_qty != null ? Math.max(1, Number(diff.new_qty)) : Math.max(1, centi(row.qty));
    const unit = diff.new_unit_price_centi != null ? centi(diff.new_unit_price_centi) : centi(row.unit_price_centi);
    const discount = centi(row.discount_centi);
    const patch: Record<string, unknown> = {
      qty,
      unit_price_centi: unit,
      line_total_centi: lineTotal(qty, unit, discount),
    };
    if (change === 'SPEC') {
      if (diff.new_material_code) patch.material_code = String(diff.new_material_code).trim();
      if (diff.new_material_name) patch.material_name = diff.new_material_name;
      if (diff.new_variants != null) patch.variants = diff.new_variants;
    }
    if (diff.new_delivery_date != null) patch.delivery_date = diff.new_delivery_date;

    const noteFromTo = (field: string, from: unknown, to: unknown) => {
      if (String(from ?? '') !== String(to ?? '')) lineFieldChanges.push({ field, from: from ?? null, to: to ?? null });
    };
    noteFromTo(`qty_${row.material_code ?? diff.purchase_order_item_id}`, row.qty, qty);
    noteFromTo(`price_${row.material_code ?? diff.purchase_order_item_id}`, row.unit_price_centi, unit);
    if (change === 'SPEC') noteFromTo(`spec_${diff.purchase_order_item_id}`, row.material_code, patch.material_code ?? row.material_code);
    if (diff.new_delivery_date != null) noteFromTo(`delivery_${row.material_code ?? diff.purchase_order_item_id}`, row.delivery_date, diff.new_delivery_date);

    const { error: updErr } = await sb
      .from('purchase_order_items')
      .update(patch)
      .eq('id', diff.purchase_order_item_id);
    if (updErr) throw new Error(`applyPoAmendment: line update failed for ${diff.purchase_order_item_id}: ${updErr.message}`);
    linesUpdated++;
  }

  // (6) Recompute the PO subtotal + total + expected_at from the LIVE line set,
  //     then bump the revision. Mirrors reviseBoundPo's roll-up.
  const { data: liveLines, error: liveErr } = await sb
    .from('purchase_order_items')
    .select('line_total_centi, delivery_date')
    .eq('purchase_order_id', poId);
  if (liveErr) throw new Error(`applyPoAmendment: PO lines re-read failed: ${liveErr.message}`);
  const rows = (liveLines ?? []) as Array<{ line_total_centi: number | null; delivery_date: string | null }>;
  const subtotal = rows.reduce((s, r) => s + centi(r.line_total_centi), 0);
  const tax = centi((poHeader as { tax_centi?: number }).tax_centi);
  const dates = rows.map((r) => r.delivery_date).filter((d): d is string => Boolean(d)).sort();

  if (rows.length === 0 && linesRemoved > 0) {
    warnings.push(`Every item on purchase order ${poNumber} was removed, so it now has no lines and may need to be cancelled.`);
  }

  const bump: Record<string, unknown> = {
    subtotal_centi: subtotal,
    total_centi:    subtotal + tax,
    revision:       nextRevision,
    updated_at:     new Date().toISOString(),
  };
  // Only let the line set drive expected_at when the header did not set it explicitly.
  if (!expectedAtOverridden) bump.expected_at = dates[0] ?? null;
  const { error: bumpErr } = await sb.from('purchase_orders').update(bump).eq('id', poId);
  if (bumpErr) throw new Error(`applyPoAmendment: PO revision bump failed: ${bumpErr.message}`);

  // (7) Audit — one AMENDMENT_PO_APPROVED row on the entity audit log (the
  //     sanctioned home for every non-SO document, mig 0139). Best-effort +
  //     non-throwing by design; the route runs the pre-flight before mutating.
  await recordEntityAudit(sb as any, {
    entityType:  'PURCHASE_ORDER',
    entityId:    poId,
    entityDocNo: poNumber,
    action:      'AMENDMENT_PO_APPROVED',
    actor:       c ? { id: c.get('houzsUser')?.id ?? null, name: c.get('houzsUser')?.name ?? null } : { id: null, name: null },
    companyId,
    fieldChanges: [
      { field: 'amendment_id', to: amendmentId },
      { field: 'po_revision', from: nextRevision - 1, to: nextRevision },
      { field: 'lines_updated', to: linesUpdated },
      { field: 'lines_added', to: linesAdded },
      { field: 'lines_removed', to: linesRemoved },
      ...headerFieldChanges,
      ...lineFieldChanges,
      ...(warnings.length ? [{ field: 'needs_attention', to: warnings.join(' | ') }] : []),
    ],
    note: `PO ${poNumber} revised to rev ${nextRevision} by amendment `
      + `(${linesUpdated} changed, ${linesAdded} added, ${linesRemoved} removed).`,
  });

  return { poId, poNumber, revision: nextRevision, linesUpdated, linesAdded, linesRemoved, warnings };
}
