// ----------------------------------------------------------------------------
// amendment-pdf-map.ts — pure mappers from the amendment DETAIL API shape into
// the shared AmendmentPdfInput (amendment-pdf.ts). Kept pure + free of React so
// they are unit-testable: the SO amendment detail page and the PO amendment
// detail page each call the matching mapper, then hand the result to
// generateAmendmentPdf.
//
// A single amendment LINE can change more than one field (a SPEC swap that also
// changes qty and price), so each changed field becomes its OWN change-table row
// sharing the line's item label — that is what the owner's before/after table
// shows. ADD / REMOVE are one row each.
// ----------------------------------------------------------------------------

import type { AmendmentChangeRow, AmendmentPdfInput } from './amendment-pdf';

const money = (centi: number | null | undefined): string =>
  centi == null ? '—' : `RM ${(Number(centi) / 100).toFixed(2)}`;

const str = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

/* ── SO amendment ──────────────────────────────────────────────────────────
   Detail shape from GET /api/scm/so-amendments/:id:
     amendment { amendment_no, status, reason, created_at, requested_by,
                 so_approved_by, so_approved_at }
     lines[]   { change_type, new_item_code, new_variants, new_qty,
                 new_unit_price_sen, old_snapshot }
     salesOrder{ doc_no, status, revision } */
export type SoAmendmentDetail = {
  amendment: {
    amendment_no?: string | null;
    status?: string | null;
    reason?: string | null;
    created_at?: string | null;
    requested_by_name?: string | null;
    so_approved_by_name?: string | null;
    so_approved_at?: string | null;
  };
  lines: Array<{
    change_type?: string | null;
    new_item_code?: string | null;
    new_qty?: number | null;
    new_unit_price_sen?: number | null;
    old_snapshot?: Record<string, unknown> | null;
  }>;
  salesOrder: { doc_no?: string | null; revision?: number | null } | null;
  customerName?: string | null;
  statusLabel?: string;
};

/* ── PO amendment ──────────────────────────────────────────────────────────
   Detail shape from GET /api/scm/po-amendments/:id:
     amendment { amendment_no, status, reason, created_at, requested_by,
                 approved_by, approved_at }
     lines[]   { change_type, new_material_code, new_material_name, new_qty,
                 new_unit_price_centi, new_delivery_date, old_snapshot }
     purchaseOrder { po_number, status, revision } */
export type PoAmendmentDetail = {
  amendment: {
    amendment_no?: string | null;
    status?: string | null;
    reason?: string | null;
    created_at?: string | null;
    requested_by_name?: string | null;
    approved_by_name?: string | null;
    approved_at?: string | null;
  };
  lines: Array<{
    change_type?: string | null;
    new_material_code?: string | null;
    new_material_name?: string | null;
    new_qty?: number | null;
    new_unit_price_centi?: number | null;
    new_delivery_date?: string | null;
    old_snapshot?: Record<string, unknown> | null;
  }>;
  purchaseOrder: { po_number?: string | null; revision?: number | null } | null;
  supplierName?: string | null;
  statusLabel?: string;
};

// A revision that reads "old -> new". An amendment applied is the PENDING (old)
// revision plus one; not-yet-applied shows the same number both sides.
function revisionPair(currentRevision: number | null | undefined, applied: boolean): { from: number; to: number } {
  const cur = Number(currentRevision ?? 1);
  return applied ? { from: cur - 1, to: cur } : { from: cur, to: cur + 1 };
}

function buildSoRows(lines: SoAmendmentDetail['lines']): AmendmentChangeRow[] {
  const rows: AmendmentChangeRow[] = [];
  for (const l of lines) {
    const change = String(l.change_type ?? '').toUpperCase();
    const snap = (l.old_snapshot ?? {}) as Record<string, unknown>;
    const item = str(l.new_item_code ?? snap.item_code ?? snap.itemCode);

    if (change === 'REMOVE') {
      rows.push({ item: str(snap.item_code ?? snap.itemCode), field: 'Line', before: `Qty ${str(snap.qty)}`, after: 'Removed', kind: 'REMOVE' });
      continue;
    }
    if (change === 'ADD') {
      rows.push({ item, field: 'Line', before: '—', after: `Qty ${str(l.new_qty)} @ ${money(l.new_unit_price_sen)}`, kind: 'ADD' });
      continue;
    }
    // SPEC / QTY — emit a row per changed field.
    if (change === 'SPEC' && l.new_item_code && String(l.new_item_code) !== String(snap.item_code ?? snap.itemCode ?? '')) {
      rows.push({ item, field: 'Spec', before: str(snap.item_code ?? snap.itemCode), after: str(l.new_item_code), kind: 'CHANGE' });
    }
    if (l.new_qty != null && String(l.new_qty) !== String(snap.qty ?? '')) {
      rows.push({ item, field: 'Quantity', before: str(snap.qty), after: str(l.new_qty), kind: 'CHANGE' });
    }
    if (l.new_unit_price_sen != null && String(l.new_unit_price_sen) !== String(snap.unit_price_sen ?? snap.unit_price_centi ?? '')) {
      rows.push({ item, field: 'Unit price', before: money((snap.unit_price_sen ?? snap.unit_price_centi) as number | null), after: money(l.new_unit_price_sen), kind: 'CHANGE' });
    }
  }
  return rows;
}

function buildPoRows(lines: PoAmendmentDetail['lines']): AmendmentChangeRow[] {
  const rows: AmendmentChangeRow[] = [];
  for (const l of lines) {
    const change = String(l.change_type ?? '').toUpperCase();
    const snap = (l.old_snapshot ?? {}) as Record<string, unknown>;
    const item = str(l.new_material_code ?? snap.material_code) + (l.new_material_name ? ` — ${l.new_material_name}` : '');

    if (change === 'REMOVE') {
      rows.push({ item: str(snap.material_name ?? snap.material_code), field: 'Line', before: `Qty ${str(snap.qty)}`, after: 'Removed', kind: 'REMOVE' });
      continue;
    }
    if (change === 'ADD') {
      rows.push({ item, field: 'Line', before: '—', after: `Qty ${str(l.new_qty)} @ ${money(l.new_unit_price_centi)}`, kind: 'ADD' });
      continue;
    }
    if (change === 'SPEC' && l.new_material_code && String(l.new_material_code) !== String(snap.material_code ?? '')) {
      rows.push({ item, field: 'Spec', before: str(snap.material_code), after: str(l.new_material_code), kind: 'CHANGE' });
    }
    if (l.new_qty != null && String(l.new_qty) !== String(snap.qty ?? '')) {
      rows.push({ item, field: 'Quantity', before: str(snap.qty), after: str(l.new_qty), kind: 'CHANGE' });
    }
    if (l.new_unit_price_centi != null && String(l.new_unit_price_centi) !== String(snap.unit_price_centi ?? '')) {
      rows.push({ item, field: 'Unit cost', before: money(snap.unit_price_centi as number | null), after: money(l.new_unit_price_centi), kind: 'CHANGE' });
    }
    if (l.new_delivery_date != null && String(l.new_delivery_date) !== String(snap.delivery_date ?? '')) {
      rows.push({ item, field: 'Delivery date', before: str(snap.delivery_date), after: str(l.new_delivery_date), kind: 'CHANGE' });
    }
  }
  return rows;
}

const isApplied = (status: string | null | undefined, appliedStates: string[]): boolean =>
  appliedStates.includes(String(status ?? '').toUpperCase());

export function soAmendmentToPdfInput(d: SoAmendmentDetail): AmendmentPdfInput {
  // The SO revision is bumped at the Approve-SO gate; treat SO_APPROVED and
  // beyond as "applied" for the old -> new display.
  const applied = isApplied(d.amendment.status, ['SO_APPROVED', 'PO_APPROVED', 'SENT', 'APPROVED']);
  const rev = revisionPair(d.salesOrder?.revision, applied);
  return {
    kind: 'SO',
    amendmentNo: str(d.amendment.amendment_no),
    issueDate: d.amendment.created_at ?? null,
    status: d.statusLabel ?? str(d.amendment.status),
    docNo: str(d.salesOrder?.doc_no),
    partyLabel: 'Customer',
    partyName: d.customerName ?? null,
    revisionFrom: rev.from,
    revisionTo: rev.to,
    changes: buildSoRows(d.lines),
    reason: d.amendment.reason ?? null,
    requestedBy: d.amendment.requested_by_name ?? null,
    requestedAt: d.amendment.created_at ?? null,
    approvedBy: d.amendment.so_approved_by_name ?? null,
    approvedAt: d.amendment.so_approved_at ?? null,
  };
}

export function poAmendmentToPdfInput(d: PoAmendmentDetail): AmendmentPdfInput {
  const applied = isApplied(d.amendment.status, ['APPROVED']);
  const rev = revisionPair(d.purchaseOrder?.revision, applied);
  return {
    kind: 'PO',
    amendmentNo: str(d.amendment.amendment_no),
    issueDate: d.amendment.created_at ?? null,
    status: d.statusLabel ?? str(d.amendment.status),
    docNo: str(d.purchaseOrder?.po_number),
    partyLabel: 'Supplier',
    partyName: d.supplierName ?? null,
    revisionFrom: rev.from,
    revisionTo: rev.to,
    changes: buildPoRows(d.lines),
    reason: d.amendment.reason ?? null,
    requestedBy: d.amendment.requested_by_name ?? null,
    requestedAt: d.amendment.created_at ?? null,
    approvedBy: d.amendment.approved_by_name ?? null,
    approvedAt: d.amendment.approved_at ?? null,
  };
}
