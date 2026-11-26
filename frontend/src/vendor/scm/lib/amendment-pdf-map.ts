
import type { AmendmentChangeRow, AmendmentPdfInput, AmendmentPdfRouting } from './amendment-pdf';
import {
  fieldKindFromLabel,
  routeField,
  summariseRouting,
  TYPE_LABEL,
  FIELD_KIND_LABEL,
} from './amendment-routing';
import { amendmentLineChangedFields, amendmentVariantSummaries } from './so-amendment-line-diff';
import { simplifiedAmendmentPill } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import { fmtSen } from '../../../../../shared/src/vendor/shared/format';

const money = (centi: number | null | undefined): string =>
  centi == null ? '—' : fmtSen(Number(centi));

const str = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

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
    new_remark?: string | null;
    new_discount_sen?: number | null;
    old_snapshot?: Record<string, unknown> | null;
  }>;
  salesOrder: { doc_no?: string | null; revision?: number | null } | null;
  customerName?: string | null;
};

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
    new_variants?: unknown;
    old_snapshot?: Record<string, unknown> | null;
  }>;
  purchaseOrder: { po_number?: string | null; revision?: number | null } | null;
  supplierName?: string | null;
};

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
      if ((l.new_remark ?? '').trim()) {
        rows.push({ item, field: 'Remark', before: '—', after: str(l.new_remark), kind: 'ADD' });
      }
      continue;
    }
    if (change === 'SPEC' && l.new_item_code && String(l.new_item_code) !== String(snap.item_code ?? snap.itemCode ?? '')) {
      rows.push({ item, field: 'Spec', before: str(snap.item_code ?? snap.itemCode), after: str(l.new_item_code), kind: 'CHANGE' });
    }
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
    if (chg.remark) {
      rows.push({
        item, field: 'Remark',
        before: str(snap.remark) || '—',
        after: (l.new_remark ?? '').trim() ? str(l.new_remark) : 'Cleared',
        kind: 'CHANGE',
      });
    }
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
    if (l.new_variants != null) {
      const vs = amendmentVariantSummaries({ change_type: change, new_variants: l.new_variants, old_snapshot: l.old_snapshot });
      if (vs.from !== vs.to) {
        rows.push({ item, field: 'Colour / fabric', before: str(vs.from), after: str(vs.to), kind: 'CHANGE' });
      }
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
