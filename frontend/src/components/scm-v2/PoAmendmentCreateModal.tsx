// ----------------------------------------------------------------------------
// PoAmendmentCreateModal — the PO amendment CREATE-request flow. A self-contained
// modal that raises an amendment against ONE live Purchase Order via
// POST /po-amendments (useCreatePoAmendment).
//
// Unlike the SO amendment (which reuses the full SO editor in "amendment mode"),
// the PO amendment create is a focused diff editor: it loads the PO's current
// lines, lets the buyer change qty / unit cost / per-line delivery date or mark a
// line REMOVED, edit the header delivery date + notes, and give a reason. It
// diffs the edits against the loaded PO and submits only the genuine changes — so
// the "N changes" the approver sees is honest.
//
// Kept OUT of the big PO editor (PurchaseOrderDetail.tsx) on purpose: that file is
// large and under concurrent edit, and the amendment create needs none of its
// pricing / line-add machinery. Adding a brand-new line and changing the supplier
// are backend-supported but deferred here (they need the product / supplier
// pickers the editor owns) — this covers the common amendment: qty, cost,
// delivery, remove, plus the header delivery date + notes.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { FilePenLine, Trash2, RotateCcw } from "lucide-react";
import { fmtMoneyCenti } from "@2990s/shared";
import { ModalOverlay } from "./DocumentRelationshipMapModal";
import { Button } from "../Button";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { humanApiError } from "../../vendor/scm/lib/authed-fetch";
import {
  usePurchaseOrderDetail,
  type PoItemRow,
} from "../../vendor/scm/lib/suppliers-queries";
import {
  useCreatePoAmendment,
  type CreatePoAmendmentLine,
  type PoAmendmentHeaderChanges,
} from "../../vendor/scm/lib/po-amendment-queries";

/* Prices are in centi (1/100 MYR); the editor works in whole MYR for the buyer
   then converts back to centi on submit. */
const centiToMyr = (centi: number | null | undefined): string =>
  centi == null ? "" : (Number(centi) / 100).toFixed(2);
const myrToCenti = (myr: string): number | null => {
  const n = Number(myr);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};
const dateOnly = (iso: string | null | undefined): string =>
  iso ? String(iso).replace(/T.*$/, "") : "";

/* Per-line editable draft. `removed` marks a REMOVE; the other fields are the
   requested new values, seeded from the current PO line. */
type LineDraft = {
  qty: string;
  unitPriceMyr: string;
  deliveryDate: string;
  removed: boolean;
};

const seedDraft = (l: PoItemRow): LineDraft => ({
  qty: String(l.qty ?? ""),
  unitPriceMyr: centiToMyr(l.unit_price_centi),
  deliveryDate: dateOnly(l.delivery_date),
  removed: false,
});

const plainError = (e: unknown): string => {
  const err = e as { status?: number; body?: string; message?: string };
  if (typeof err?.status === "number" && typeof err?.body === "string") {
    return humanApiError(err.status, err.body);
  }
  return err?.message ?? "Something went wrong. Please try again.";
};

export function PoAmendmentCreateModal({
  poId,
  poNumber,
  onClose,
  onCreated,
}: {
  poId: string;
  poNumber: string;
  onClose: () => void;
  onCreated?: (amendmentId: string) => void;
}) {
  const notify = useNotify();
  const detail = usePurchaseOrderDetail(poId);
  const create = useCreatePoAmendment();

  const header = detail.data?.purchaseOrder ?? null;
  const items = useMemo<PoItemRow[]>(() => detail.data?.items ?? [], [detail.data]);

  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [expectedAt, setExpectedAt] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  // Seed drafts + header fields once the PO detail lands.
  const seeded = useMemo(() => {
    if (!header) return false;
    return true;
  }, [header]);
  // Lazy seed: build the effective draft for a line (falls back to its seed).
  const draftOf = (l: PoItemRow): LineDraft => drafts[l.id] ?? seedDraft(l);
  const setDraft = (l: PoItemRow, patch: Partial<LineDraft>) =>
    setDrafts((prev) => ({ ...prev, [l.id]: { ...draftOf(l), ...patch } }));

  const effectiveExpectedAt = expectedAt ?? dateOnly(header?.expected_at);
  const effectiveNotes = notes ?? (header?.notes ?? "");

  /* Build the amendment payload — only genuine deltas become lines / header
     changes, so a no-op submit is impossible (the backend also 400s empty). */
  const buildPayload = (): { lines: CreatePoAmendmentLine[]; headerChanges: PoAmendmentHeaderChanges } => {
    const lines: CreatePoAmendmentLine[] = [];
    for (const l of items) {
      const d = draftOf(l);
      const oldSnapshot = {
        material_code: l.material_code,
        material_name: l.material_name,
        qty: l.qty,
        unit_price_centi: l.unit_price_centi,
        delivery_date: dateOnly(l.delivery_date) || null,
      };
      if (d.removed) {
        lines.push({ purchaseOrderItemId: l.id, changeType: "REMOVE", oldSnapshot });
        continue;
      }
      const newQty = Number(d.qty);
      const newCenti = myrToCenti(d.unitPriceMyr);
      const newDelivery = d.deliveryDate || null;
      const qtyChanged = Number.isFinite(newQty) && newQty !== Number(l.qty ?? 0);
      const priceChanged = newCenti != null && newCenti !== Number(l.unit_price_centi ?? 0);
      const deliveryChanged = (newDelivery ?? null) !== (dateOnly(l.delivery_date) || null);
      if (!qtyChanged && !priceChanged && !deliveryChanged) continue;
      // A single line can move qty + cost + delivery together; the backend applies
      // whatever new_* fields are present. Classify by the dominant field.
      const changeType = priceChanged && !qtyChanged && !deliveryChanged ? "PRICE"
        : deliveryChanged && !qtyChanged && !priceChanged ? "DELIVERY"
        : "QTY";
      lines.push({
        purchaseOrderItemId: l.id,
        changeType,
        newQty: qtyChanged ? newQty : undefined,
        newUnitPriceCenti: priceChanged ? newCenti : undefined,
        newDeliveryDate: deliveryChanged ? newDelivery : undefined,
        oldSnapshot,
      });
    }

    const headerChanges: PoAmendmentHeaderChanges = {};
    const origExpected = dateOnly(header?.expected_at) || null;
    if ((effectiveExpectedAt || null) !== origExpected) {
      headerChanges.expected_at = effectiveExpectedAt || null;
    }
    const origNotes = header?.notes ?? "";
    if (effectiveNotes.trim() !== origNotes.trim()) {
      headerChanges.notes = effectiveNotes.trim() || null;
    }
    return { lines, headerChanges };
  };

  const submit = async () => {
    const { lines, headerChanges } = buildPayload();
    if (lines.length === 0 && Object.keys(headerChanges).length === 0) {
      notify({
        title: "Nothing to submit",
        body: "Change a quantity, a cost, a delivery date or the notes first — an amendment must request at least one change.",
        tone: "error",
      });
      return;
    }
    try {
      const res = await create.mutateAsync({
        poId,
        reason: reason.trim() || undefined,
        headerChanges: Object.keys(headerChanges).length > 0 ? headerChanges : undefined,
        lines,
        idempotencyKey: `po-amd-${poId}-${Date.now()}`,
      });
      notify({ title: "Amendment raised", body: `${res.amendment.amendment_no ?? poNumber} is now awaiting approval.` });
      onCreated?.(res.amendment.id);
      onClose();
    } catch (e) {
      notify({
        title: "Could not raise the amendment",
        body: `${plainError(e)} Nothing was changed — please try again.`,
        tone: "error",
      });
    }
  };

  const inputCls =
    "w-full rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink outline-none focus:border-primary/60";

  return (
    <ModalOverlay
      open
      onClose={onClose}
      title={`Raise amendment · ${poNumber}`}
      icon={<FilePenLine size={16} />}
      size="lg"
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={create.isPending || !seeded}>
            {create.isPending ? "Submitting…" : "Submit amendment request"}
          </Button>
        </>
      }
    >
      {detail.isPending ? (
        <div className="py-8 text-center text-[13px] text-ink-muted">Loading purchase order…</div>
      ) : detail.error || !header ? (
        <div className="py-8 text-center text-[13px] text-err">Couldn't load this purchase order.</div>
      ) : (
        <div className="space-y-4">
          <p className="text-[12px] text-ink-secondary">
            Change the lines below, then submit. An approver applies the change in place and the
            Purchase Order keeps a snapshot of its prior revision.
          </p>

          {/* Line editor */}
          <div className="space-y-2">
            {items.map((l) => {
              const d = draftOf(l);
              return (
                <div
                  key={l.id}
                  className={`rounded-md border px-3 py-2.5 ${d.removed ? "border-err/40 bg-err/5" : "border-border"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[12.5px] font-semibold text-ink">{l.material_code}</div>
                      <div className="text-[11px] text-ink-secondary">{l.material_name}</div>
                      {Number(l.received_qty ?? 0) > 0 && (
                        <div className="mt-0.5 text-[10.5px] text-warn">
                          {l.received_qty} already received — a revised qty cannot drop below this.
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDraft(l, { removed: !d.removed })}
                      className={`flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold ${
                        d.removed
                          ? "border-border bg-surface text-ink-secondary hover:text-primary"
                          : "border-err/40 bg-err/5 text-err hover:bg-err/10"
                      }`}
                    >
                      {d.removed ? <><RotateCcw size={12} /> Keep</> : <><Trash2 size={12} /> Remove</>}
                    </button>
                  </div>
                  {!d.removed && (
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <label className="block">
                        <span className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">Qty</span>
                        <input
                          type="number"
                          className={inputCls}
                          value={d.qty}
                          min={0}
                          onChange={(e) => setDraft(l, { qty: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">Unit cost (RM)</span>
                        <input
                          type="number"
                          className={inputCls}
                          value={d.unitPriceMyr}
                          min={0}
                          step="0.01"
                          onChange={(e) => setDraft(l, { unitPriceMyr: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">Delivery date</span>
                        <input
                          type="date"
                          className={inputCls}
                          value={d.deliveryDate}
                          onChange={(e) => setDraft(l, { deliveryDate: e.target.value })}
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
            {items.length === 0 && (
              <div className="text-[12px] text-ink-muted">This purchase order has no lines to amend.</div>
            )}
          </div>

          {/* Header changes */}
          <div className="grid grid-cols-2 gap-2 border-t border-border-subtle pt-3">
            <label className="block">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">PO delivery date</span>
              <input
                type="date"
                className={inputCls}
                value={effectiveExpectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">Notes</span>
              <input
                type="text"
                className={inputCls}
                value={effectiveNotes}
                placeholder="Header notes"
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>

          {/* Reason */}
          <label className="block">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Reason (optional)</span>
            <input
              type="text"
              className={`${inputCls} mt-1`}
              value={reason}
              placeholder="Why is this change needed?"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          {/* Money summary — round, honest total of the requested lines. */}
          <div className="flex items-center justify-between border-t border-border-subtle pt-3 text-[12px]">
            <span className="text-ink-muted">Current PO total</span>
            <span className="font-money font-semibold text-ink">{fmtMoneyCenti(header.total_centi)}</span>
          </div>
        </div>
      )}
    </ModalOverlay>
  );
}

export default PoAmendmentCreateModal;
