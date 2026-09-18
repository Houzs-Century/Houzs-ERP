/* ------------------------------------------------------------------------- *
 * MobilePurchaseDocNew — create a Purchase Order, Goods Receipt or Purchase
 * Invoice DIRECTLY on the phone.
 *
 * Owner 2026-09-12: 「电脑版本有的，手机版本都要有」 — and the convert wizard is
 * not what he wants for creating. The desktop has three direct-create pages
 * (PurchaseOrderNew, GrnNew, PurchaseInvoiceNew); the phone's "+" on those lists
 * could only convert FROM a source document (PO from a Sales Order, GRN from a
 * PO) and Purchase Invoices had no "+" at all. Converting stays one tap away on
 * this screen, because it is still a desktop flow too.
 *
 * ONE SHARED LOGIC LAYER. This file is presentation plus the mutation wiring:
 *   - what each document needs and the body it sends: ./mobile-purchase-doc.ts
 *   - the PO variant gate: vendor/shared/so-variant-rule (via that file)
 *   - the create / post calls: the SAME vendored hooks the desktop pages call
 *     (useCreatePurchaseOrder, useCreateGrn + usePostGrn,
 *     useCreatePurchaseInvoice + usePostPurchaseInvoice)
 *   - refusals: zero-cost-refusal.ts for a GRN, ac-not-sent.tsx for "the
 *     accounts did not get all of it", mutation-error.ts for stock not moved
 *   - who may open it: auth/salesAccess (MobileApp decides, not this file)
 *
 * WHAT THE PHONE FORM DOES NOT DO YET — stated so nobody reads it as parity:
 *   - no product-option editor (fabric / size / heights). A sofa or bedframe PO
 *     line can be SAVED AS A DRAFT and completed on desktop; CONFIRM is refused
 *     with the desktop's own message, from the shared rule.
 *   - no supplier price auto-fill (desktop prices a PO from the supplier's price
 *     table). The buyer types the unit price.
 *   - MYR only (desktop offers foreign currency + exchange rate + landed-cost
 *     allocation on GRN / PI).
 *   - no per-line delivery date, warehouse override, discount or rack.
 * ------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateMobileLists } from "./sharedInvalidate";
import { lineIdentity } from "@2990s/shared";
import { todayMyt } from "../vendor/scm/lib/dates";
import { useWarehouses } from "../vendor/scm/lib/inventory-queries";
import { useSuppliers, useCreatePurchaseOrder } from "../vendor/scm/lib/suppliers-queries";
import { useCreateGrn, usePostGrn } from "../vendor/scm/lib/grn-queries";
import { useCreatePurchaseInvoice, usePostPurchaseInvoice } from "../vendor/scm/lib/purchase-invoice-queries";
import { zeroCostRefusalFrom, zeroCostRefusalText } from "../vendor/scm/lib/zero-cost-refusal";
import { reportInBandFailure } from "../vendor/scm/lib/mutation-error";
import { notifyAcNotSent } from "../vendor/scm/lib/ac-not-sent";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MoneyInput } from "../vendor/scm/components/MoneyInput";
import { DateField } from "../vendor/scm/components/DateField";
import { useIdempotencyKey } from "../lib/idempotency";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import {
  PURCHASE_DOC_CONFIG,
  buildGrnPayload,
  buildPiPayload,
  buildPoPayload,
  createBlockers,
  poConfirmVariantGaps,
  variantGapMessage,
  type PurchaseDocKind,
  type PurchaseHeaderDraft,
  type PurchaseLineDraft,
} from "./mobile-purchase-doc";

let seq = 0;
const newKey = () => `pl${seq++}`;

/** Where a created document came from, for the success message. */
type Created = { id: string; number: string };

function errorText(err: unknown): string {
  const zc = zeroCostRefusalFrom(err);
  if (zc) return zeroCostRefusalText(zc);
  return err instanceof Error && err.message ? err.message : "Something went wrong.";
}

function PurchaseLine({
  line, onQty, onPrice, onRemark, onRemove,
}: {
  line: PurchaseLineDraft;
  onQty: (qty: number) => void;
  onPrice: (sen: number | null) => void;
  onRemark: (remark: string) => void;
  onRemove: () => void;
}) {
  const id = lineIdentity({ code: line.itemCode, description: line.name });
  return (
    <div className="st-line">
      <div className="lh">
        <div style={{ minWidth: 0 }}>
          <div className="sku">{id.primary}</div>
          {line.name && line.name !== id.primary && <div className="code">{line.name}</div>}
        </div>
        <button className="x" onClick={onRemove} aria-label={`Remove ${line.itemCode}`}>×</button>
      </div>
      <div className="qtyrow" style={{ justifyContent: "space-between" }}>
        <div className="stepper">
          <button onClick={() => onQty(line.qty - 1)} aria-label={`Decrease ${line.itemCode}`}>−</button>
          <span className="q tnum" aria-label={`Quantity ${line.itemCode}`}>{line.qty}</span>
          <button onClick={() => onQty(line.qty + 1)} aria-label={`Increase ${line.itemCode}`}>+</button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--mut)" }}>
          RM
          <MoneyInput
            bare
            inputClassName="cal-sel"
            style={{ width: 110, textAlign: "right" }}
            valueSen={line.unitPriceSen}
            onCommit={(sen) => onPrice(sen)}
            allowBlank
            placeholder="0.00"
            selectOnFocus
            aria-label={`Unit price ${line.itemCode}`}
          />
        </label>
      </div>
      <input
        className="cal-sel"
        value={line.remark}
        onChange={(e) => onRemark(e.target.value)}
        placeholder="Line remark (optional)"
        aria-label={`Remark ${line.itemCode}`}
      />
    </div>
  );
}

export function MobilePurchaseDocNew({
  kind,
  onBack,
  onCreated,
  onConvertInstead,
}: {
  kind: PurchaseDocKind;
  onBack: () => void;
  onCreated: () => void;
  /** The existing convert wizard for this document, or null where the phone has
   *  none (a PI from a GRN is desktop-only today). Required, not optional: a
   *  caller that forgets it would silently hide a flow the desktop offers. */
  onConvertInstead: { label: string; open: () => void } | null;
}) {
  const cfg = PURCHASE_DOC_CONFIG[kind];
  const notify = useNotify();
  const qc = useQueryClient();
  /* One key per mount = one document. MobileApp leaves this screen on success
     (onCreated), so a second document always gets a fresh mount and a fresh key,
     while a re-press after a stalled or half-failed submit REPLAYS the first
     document instead of creating a second one (lib/idempotency.ts). */
  const idemKey = useIdempotencyKey();

  const suppliersQ = useSuppliers({ status: "ACTIVE" });
  const warehousesQ = useWarehouses();
  const createPo = useCreatePurchaseOrder();
  const createGrn = useCreateGrn();
  const postGrn = usePostGrn();
  const createPi = useCreatePurchaseInvoice();
  const postPi = usePostPurchaseInvoice();

  const [header, setHeader] = useState<PurchaseHeaderDraft>(() => ({
    supplierId: "",
    docDate: todayMyt(),
    secondDate: "",
    warehouseId: "",
    reference: "",
    notes: "",
  }));
  const [lines, setLines] = useState<PurchaseLineDraft[]>([]);
  const [supplierFilter, setSupplierFilter] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<PurchaseHeaderDraft>) => setHeader((h) => ({ ...h, ...patch }));
  const setLine = (key: string, patch: Partial<PurchaseLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const suppliers = useMemo(() => {
    const q = supplierFilter.trim().toLowerCase();
    const all = suppliersQ.data ?? [];
    const hit = q ? all.filter((s) => `${s.code} ${s.name}`.toLowerCase().includes(q)) : all;
    /* Keep the chosen supplier selectable even when the filter hides it, or the
       <select> would silently show the first match while the header holds a
       different id. */
    const chosen = all.find((s) => s.id === header.supplierId);
    return chosen && !hit.includes(chosen) ? [chosen, ...hit] : hit;
  }, [suppliersQ.data, supplierFilter, header.supplierId]);

  const blockers = createBlockers(kind, header, lines);
  const canSubmit = blockers.length === 0 && !busy;

  const addSku = (sku: PickedSku) => {
    setPickerOpen(false);
    setLines((prev) => [
      ...prev,
      /* unitPriceSen starts BLANK on purpose — see PurchaseLineDraft for both
         reasons (never the catalog selling price; never a "0.00" that drops the
         buyer's keystrokes). */
      { key: newKey(), itemCode: sku.itemCode, name: sku.name, itemGroup: sku.itemGroup, qty: 1, unitPriceSen: null, remark: "" },
    ]);
  };

  const finish = async (created: Created, asDraft: boolean) => {
    /* The vendored hooks refresh the desktop's canonical keys; the phone list
       this screen returns to reads its OWN keys, paged ones included. */
    invalidateMobileLists(qc);
    await notify({
      title: `${cfg.label} ${created.number} ${asDraft ? "saved as draft" : "created"}`,
    });
    onCreated();
  };

  const submit = async (asDraft: boolean) => {
    if (!canSubmit) return;
    if (kind === "po" && !asDraft) {
      const gaps = poConfirmVariantGaps(lines);
      if (gaps.length > 0) {
        const msg = variantGapMessage(gaps);
        await notify({ title: msg.title, body: msg.body, tone: "error" });
        return;
      }
    }
    setBusy(true);
    try {
      if (kind === "po") {
        const res = await createPo.mutateAsync({ idempotencyKey: idemKey, ...buildPoPayload(header, lines, asDraft) });
        await notifyAcNotSent(notify, res, "Purchase order");
        await finish({ id: res.id, number: res.poNumber }, asDraft);
      } else if (kind === "grn") {
        const res = await createGrn.mutateAsync({ idempotencyKey: idemKey, ...buildGrnPayload(header, lines, asDraft) });
        /* POST /grns posts a non-draft receipt itself and answers
           `movementErrors` in-band when the stock write was refused. */
        reportInBandFailure("Goods receipt saved, but the stock was not received", res as { movementErrors?: string[] });
        /* Same second call as desktop GrnNew — an idempotent no-op on an
           already-POSTED receipt, and the commit on a replayed one. */
        if (!asDraft) await postGrn.mutateAsync(res.id);
        await notifyAcNotSent(notify, res, "Goods receipt");
        await finish({ id: res.id, number: res.grnNumber }, asDraft);
      } else {
        const res = await createPi.mutateAsync({ idempotencyKey: idemKey, ...buildPiPayload(header, lines, asDraft) });
        /* PurchaseInvoiceNew: "Auto-post (Confirm) so PI lands in POSTED state".
           Without it the AP liability is never recorded. */
        if (!asDraft) await postPi.mutateAsync(res.id);
        await notifyAcNotSent(notify, res, "Purchase invoice");
        await finish({ id: res.id, number: res.invoiceNumber }, asDraft);
      }
    } catch (err) {
      /* Every refusal reaches the operator in words: the server's own message,
         or for a zero-cost receipt the shared sentence naming which lines and
         what they normally cost. The post hooks carry their own onError too. */
      await notify({ title: `${cfg.label} not saved`, body: errorText(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  /* `.st-fld` carries `flex: 1`, which is what a field wants inside a ROW
     (`.st-whrow` shares the width) and exactly wrong in the vertical scroll
     column, where it GROWS into free space. PLACEMENT is therefore a required
     argument, not a default: the rack screen (#3788) shipped that grow bug past
     11 passing tests and was only caught by rendering it at 375px. */
  const field = (placement: "row" | "column", label: string, control: React.ReactNode) => (
    <div className="st-fld" style={placement === "column" ? { flex: "none" } : undefined}>
      <span className="st-fl">{label}</span>
      {control}
    </div>
  );

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">Purchasing · New</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{cfg.title}</div>
        </div>
      </header>

      <div
        className="hz-scroll"
        style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}
      >
        {onConvertInstead && (
          <button className="chip" style={{ alignSelf: "flex-start" }} onClick={onConvertInstead.open}>
            {onConvertInstead.label}
          </button>
        )}

        {field("column", "Supplier", (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              className="cal-sel"
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              placeholder="Search supplier code or name"
              aria-label="Search supplier"
            />
            <select
              className="cal-sel"
              aria-label="Supplier"
              value={header.supplierId}
              onChange={(e) => set({ supplierId: e.target.value })}
            >
              <option value="">
                {suppliersQ.isLoading ? "Loading suppliers…" : suppliersQ.isError ? "Could not load suppliers" : "Select supplier…"}
              </option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
              ))}
            </select>
          </div>
        ))}

        <div className="st-whrow" style={{ flex: "none" }}>
          {field("row", cfg.docDateLabel, (
            <DateField fullWidth className="cal-sel" value={header.docDate} onChange={(iso) => set({ docDate: iso })} aria-label={cfg.docDateLabel} />
          ))}
          {cfg.secondDateLabel && field("row", cfg.secondDateLabel, (
            <DateField fullWidth className="cal-sel" value={header.secondDate} onChange={(iso) => set({ secondDate: iso })} aria-label={cfg.secondDateLabel} />
          ))}
        </div>

        {cfg.warehouseLabel && field("column", cfg.warehouseLabel, (
          <select
            className="cal-sel"
            aria-label={cfg.warehouseLabel}
            value={header.warehouseId}
            onChange={(e) => set({ warehouseId: e.target.value })}
          >
            <option value="">{warehousesQ.isError ? "Could not load warehouses" : "Select warehouse…"}</option>
            {(warehousesQ.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        ))}

        {cfg.referenceLabel && field("column", cfg.referenceLabel, (
          <input className="cal-sel" value={header.reference} onChange={(e) => set({ reference: e.target.value })} aria-label={cfg.referenceLabel} placeholder="Optional" />
        ))}

        {field("column", "Notes", (
          <input className="cal-sel" value={header.notes} onChange={(e) => set({ notes: e.target.value })} aria-label="Notes" placeholder="Optional" />
        ))}

        <div className="sc-sl"><span className="t">Items</span><span className="ln" /></div>
        {lines.map((l) => (
          <PurchaseLine
            key={l.key}
            line={l}
            onQty={(qty) => setLine(l.key, { qty: Math.max(1, qty) })}
            onPrice={(sen) => setLine(l.key, { unitPriceSen: sen })}
            onRemark={(remark) => setLine(l.key, { remark })}
            onRemove={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
          />
        ))}
        <button className="st-addln" style={{ flex: "none" }} onClick={() => setPickerOpen(true)}>+ Add item</button>

        {blockers.length > 0 && (
          <div className="st-warn" role="status" style={{ flex: "none" }}>
            {blockers.join(" ")}
          </div>
        )}
      </div>

      <div className="actbar" style={{ display: "flex", gap: 10 }}>
        <button
          className="btn-ghost"
          disabled={!canSubmit}
          style={{ opacity: canSubmit ? 1 : 0.5 }}
          onClick={() => void submit(true)}
        >
          Save draft
        </button>
        <button
          className="btn"
          disabled={!canSubmit}
          style={{ opacity: canSubmit ? 1 : 0.5 }}
          onClick={() => void submit(false)}
        >
          {busy ? "Saving…" : cfg.confirmLabel}
        </button>
      </div>

      {pickerOpen && <MobileSkuPicker onPick={addSku} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

export default MobilePurchaseDocNew;
