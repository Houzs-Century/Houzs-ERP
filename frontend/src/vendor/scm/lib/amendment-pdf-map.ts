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

import type { AmendmentChangeRow, AmendmentPdfInput, AmendmentPdfRouting } from './amendment-pdf';
import {
  fieldKindFromLabel,
  routeField,
  summariseRouting,
  TYPE_LABEL,
  FIELD_KIND_LABEL,
} from './amendment-routing';
import { amendmentLineChangedFields, amendmentVariantSummaries } from './so-amendment-line-diff';
/* The printed Status comes from the one home for the amendment vocabulary, not
   from a caller-supplied word. See PRINTED STATUS below. */
import { simplifiedAmendmentPill } from './status-pill';

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
    new_variants?: unknown;
    /* mig 0280 — the requested line REMARK. null = not requested. */
    new_remark?: string | null;
    new_discount_sen?: number | null;
    old_snapshot?: Record<string, unknown> | null;
  }>;
  salesOrder: { doc_no?: string | null; revision?: number | null } | null;
  customerName?: string | null;
};

/* ── PO amendment ──────────────────────────────────────────────────────────
   Detail shape from GET /api/scm/po-amendments/:id:
     amendment { amendment_no, status, reason, created_at, requested_by,
                 approved_by, approved_at }
     lines[]   { change_type, new_item_code, new_material_name, new_qty,
                 new_unit_price_sen, new_delivery_date, old_snapshot }
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
    new_item_code?: string | null;
    new_material_name?: string | null;
    new_qty?: number | null;
    new_unit_price_sen?: number | null;
    new_delivery_date?: string | null;
    old_snapshot?: Record<string, unknown> | null;
  }>;
  purchaseOrder: { po_number?: string | null; revision?: number | null } | null;
  supplierName?: string | null;
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
      /* mig 0280 — an added SERVICE line's remark IS the job ("Please take back
         Cody Bedframe (King Size) 2 units"). Printing the qty and price alone
         hands the supplier / approver a document that omits the instruction. */
      if ((l.new_remark ?? '').trim()) {
        rows.push({ item, field: 'Remark', before: '—', after: str(l.new_remark), kind: 'ADD' });
      }
      continue;
    }
    // SPEC / VARIANT / QTY / PRICE — emit a row per changed field.
    if (change === 'SPEC' && l.new_item_code && String(l.new_item_code) !== String(snap.item_code ?? snap.itemCode ?? '')) {
      rows.push({ item, field: 'Spec', before: str(snap.item_code ?? snap.itemCode), after: str(l.new_item_code), kind: 'CHANGE' });
    }
    // Colour / fabric (variant) — routed to Production / Design like the spec. Use
    // the shared alias-aware diff so a canonicalised-but-identical blob is not a
    // false change (the same guard the on-screen diff uses).
    const chg = amendmentLineChangedFields({
      change_type: change, new_item_code: l.new_item_code, new_qty: l.new_qty,
      new_unit_price_sen: l.new_unit_price_sen, new_variants: l.new_variants,
      new_remark: l.new_remark, new_discount_sen: l.new_discount_sen,
      old_snapshot: l.old_snapshot,
    });
    if (chg.variants) {
      const vs = amendmentVariantSummaries({
        change_type: change, new_variants: l.new_variants, old_snapshot: l.old_snapshot,
      });
      rows.push({ item, field: 'Colour / fabric', before: str(vs.from), after: str(vs.to), kind: 'CHANGE' });
    }
    if (l.new_qty != null && String(l.new_qty) !== String(snap.qty ?? '')) {
      rows.push({ item, field: 'Quantity', before: str(snap.qty), after: str(l.new_qty), kind: 'CHANGE' });
    }
    if (l.new_unit_price_sen != null && String(l.new_unit_price_sen) !== String(snap.unit_price_sen ?? snap.unit_price_sen ?? '')) {
      rows.push({ item, field: 'Unit price', before: money((snap.unit_price_sen ?? snap.unit_price_sen) as number | null), after: money(l.new_unit_price_sen), kind: 'CHANGE' });
    }
    /* mig 0280 — routed through the shared changed-fields test above so the
       printed document and the on-screen card never disagree about whether the
       remark moved. An emptied remark prints as "Cleared", never as a blank
       cell that reads like the row was left out. */
    if (chg.remark) {
      rows.push({
        item, field: 'Remark',
        before: str(snap.remark) || '—',
        after: (l.new_remark ?? '').trim() ? str(l.new_remark) : 'Cleared',
        kind: 'CHANGE',
      });
    }
    /* mig 0317 — on a delivery-fee line the discount IS the request (the unit
       stays derived), so a printed document without this row omits the money. */
    if (chg.discount) {
      rows.push({
        item, field: 'Discount',
        before: money((snap.discountSen as number | null | undefined) ?? 0),
        after: money(l.new_discount_sen ?? 0),
        kind: 'CHANGE',
      });
    }
  }
  return rows;
}

function buildPoRows(lines: PoAmendmentDetail['lines']): AmendmentChangeRow[] {
  const rows: AmendmentChangeRow[] = [];
  for (const l of lines) {
    const change = String(l.change_type ?? '').toUpperCase();
    const snap = (l.old_snapshot ?? {}) as Record<string, unknown>;
    const item = str(l.new_item_code ?? snap.item_code) + (l.new_material_name ? ` — ${l.new_material_name}` : '');

    if (change === 'REMOVE') {
      rows.push({ item: str(snap.material_name ?? snap.item_code), field: 'Line', before: `Qty ${str(snap.qty)}`, after: 'Removed', kind: 'REMOVE' });
      continue;
    }
    if (change === 'ADD') {
      rows.push({ item, field: 'Line', before: '—', after: `Qty ${str(l.new_qty)} @ ${money(l.new_unit_price_sen)}`, kind: 'ADD' });
      continue;
    }
    if (change === 'SPEC' && l.new_item_code && String(l.new_item_code) !== String(snap.item_code ?? '')) {
      rows.push({ item, field: 'Spec', before: str(snap.item_code), after: str(l.new_item_code), kind: 'CHANGE' });
    }
    if (l.new_qty != null && String(l.new_qty) !== String(snap.qty ?? '')) {
      rows.push({ item, field: 'Quantity', before: str(snap.qty), after: str(l.new_qty), kind: 'CHANGE' });
    }
    if (l.new_unit_price_sen != null && String(l.new_unit_price_sen) !== String(snap.unit_price_sen ?? '')) {
      rows.push({ item, field: 'Unit cost', before: money(snap.unit_price_sen as number | null), after: money(l.new_unit_price_sen), kind: 'CHANGE' });
    }
    if (l.new_delivery_date != null && String(l.new_delivery_date) !== String(snap.delivery_date ?? '')) {
      rows.push({ item, field: 'Delivery date', before: str(snap.delivery_date), after: str(l.new_delivery_date), kind: 'CHANGE' });
    }
  }
  return rows;
}

const isApplied = (status: string | null | undefined, appliedStates: string[]): boolean =>
  appliedStates.includes(String(status ?? '').toUpperCase());

/* Tag each change row with its responsible department (from its field label) and
   fold the whole set into the type badges + department-routing block the PDF
   prints. Rows whose field is not routable keep a null department. */
function attachRouting(rows: AmendmentChangeRow[]): { rows: AmendmentChangeRow[]; routing: AmendmentPdfRouting } {
  const tagged = rows.map((r) => {
    const kind = fieldKindFromLabel(r.field);
    return { ...r, department: kind ? routeField(kind).department : null };
  });
  const summary = summariseRouting(tagged.map((r) => fieldKindFromLabel(r.field)));
  const routing: AmendmentPdfRouting = {
    typeLabels: summary.types.map((t) => TYPE_LABEL[t]),
    isMixed: summary.isMixed,
    departments: summary.departments.map((d) => ({
      department: d.department,
      fields: d.kinds.map((k) => FIELD_KIND_LABEL[k]),
    })),
  };
  return { rows: tagged, routing };
}

/* PRINTED STATUS — the amendment document's Status field.
 *
 * It used to be a `statusLabel?: string` on the input, and all four callers
 * (SO + PO amendment detail, desktop + mobile) hand-wrote the SAME expression:
 * `applied ? "Approved" : "Requested"`. That is CLAUDE.md's optional-param-noop
 * shape carrying a two-way collapse of a SIX-value vocabulary, and it got
 * REJECTED wrong on all four: a rejected amendment printed **Requested**, the
 * one word that says the decision has not been made yet.
 *
 * `simplifiedAmendmentPill` is the canonical implementation of the collapse the
 * owner chose for the amendment LISTS (2026-07-24, Requested / Approved / All),
 * so this is the same three words the screens show, from one place. Output is
 * identical for every status except REJECTED, which is the defect.
 *
 * NOT settled here, deliberately: the amendment DETAIL page shows the GRANULAR
 * pill (`resolveStatusPill('soAmendment', …)` — Supplier Pending, SO Approved,
 * Sent), so paper and that screen still differ on the in-flight states. Which
 * vocabulary the printed document should carry is the owner's call, not a
 * defect to fix quietly. */
export const amendmentPrintedStatus = (status: string | null | undefined): string =>
  simplifiedAmendmentPill(status).label;

export function soAmendmentToPdfInput(d: SoAmendmentDetail): AmendmentPdfInput {
  // The SO revision is bumped at the Approve-SO gate; treat SO_APPROVED and
  // beyond as "applied" for the old -> new display.
  const applied = isApplied(d.amendment.status, ['SO_APPROVED', 'PO_APPROVED', 'SENT', 'APPROVED']);
  const rev = revisionPair(d.salesOrder?.revision, applied);
  const { rows, routing } = attachRouting(buildSoRows(d.lines));
  return {
    kind: 'SO',
    amendmentNo: str(d.amendment.amendment_no),
    issueDate: d.amendment.created_at ?? null,
    status: amendmentPrintedStatus(d.amendment.status),
    docNo: str(d.salesOrder?.doc_no),
    partyLabel: 'Customer',
    partyName: d.customerName ?? null,
    revisionFrom: rev.from,
    revisionTo: rev.to,
    changes: rows,
    routing,
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
  const { rows, routing } = attachRouting(buildPoRows(d.lines));
  return {
    kind: 'PO',
    amendmentNo: str(d.amendment.amendment_no),
    issueDate: d.amendment.created_at ?? null,
    status: amendmentPrintedStatus(d.amendment.status),
    docNo: str(d.purchaseOrder?.po_number),
    partyLabel: 'Supplier',
    partyName: d.supplierName ?? null,
    revisionFrom: rev.from,
    revisionTo: rev.to,
    changes: rows,
    routing,
    reason: d.amendment.reason ?? null,
    requestedBy: d.amendment.requested_by_name ?? null,
    requestedAt: d.amendment.created_at ?? null,
    approvedBy: d.amendment.approved_by_name ?? null,
    approvedAt: d.amendment.approved_at ?? null,
  };
}
