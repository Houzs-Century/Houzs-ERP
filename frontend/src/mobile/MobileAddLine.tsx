
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lineIdentity } from "@2990s/shared";
import { useAuth } from "../auth/AuthContext";
import { ADD_LINE_LABEL } from "../vendor/scm/lib/add-line-handoff";
import { useAddPurchaseOrderItem } from "../vendor/scm/lib/suppliers-queries";
import { useAddGrnItem } from "../vendor/scm/lib/grn-queries";
import { useAddPurchaseInvoiceItem } from "../vendor/scm/lib/purchase-invoice-queries";
import { useAddSalesInvoiceItem } from "../vendor/scm/lib/sales-invoice-queries";
import { zeroCostRefusalFrom, zeroCostRefusalText } from "../vendor/scm/lib/zero-cost-refusal";
import { MoneyInput } from "../vendor/scm/components/MoneyInput";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import { invalidateMobileLists } from "./sharedInvalidate";
import {
  MODULE_TO_ADD_LINE_DOC,
  addLineBlockers,
  addLinePayload,
  mayAddLine,
  type AddLineDoc,
  type AddLineDraft,
  type AddLineHeader,
} from "./mobile-add-line";

const EMPTY: AddLineDraft = { itemCode: "", name: "", itemGroup: "", qty: 1, unitPriceSen: null };

function refusalText(err: unknown): string {
  const zc = zeroCostRefusalFrom(err);
  if (zc) return zeroCostRefusalText(zc);
  return err instanceof Error && err.message ? err.message : "The line was not added. Please try again.";
}

/** Mount under a document's line items. Renders nothing for a module without
 *  "Add line", for a person who may not write it, or for a closed document. */
export function MobileAddLine({
  moduleKey,
  docId,
  header,
  onAdded,
}: {
  moduleKey: string;
  docId: string;
  header: AddLineHeader;
  onAdded: () => void;
}) {
  const doc = MODULE_TO_ADD_LINE_DOC[moduleKey];
  const { user, can, pageAccess } = useAuth();
  if (doc === undefined || !mayAddLine(doc, header, { user, can, pageAccess })) return null;
  return <AddLineRow doc={doc} docId={docId} header={header} onAdded={onAdded} />;
}

function AddLineRow({ doc, docId, header, onAdded }: { doc: AddLineDoc; docId: string; header: AddLineHeader; onAdded: () => void }) {
  const qc = useQueryClient();
  const po = useAddPurchaseOrderItem();
  const grn = useAddGrnItem();
  const pi = useAddPurchaseInvoiceItem();
  const si = useAddSalesInvoiceItem();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AddLineDraft>(EMPTY);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setOpen(false); setDraft(EMPTY); setError(null); };
  const blockers = addLineBlockers(draft);

  const pick = (sku: PickedSku) => {
    setPickerOpen(false);
    setDraft((d) => ({ ...d, itemCode: sku.itemCode, name: sku.name, itemGroup: sku.itemGroup }));
  };

  const submit = async () => {
    if (blockers.length > 0 || busy) return;
    setError(null);
    setBusy(true);
    const receivedOn = doc === "grn" ? (String((header ?? {}).received_at ?? "").slice(0, 10) || null) : null;
    const body = addLinePayload(doc, docId, draft, receivedOn);
    try {
      if (doc === "po") await po.mutateAsync(body as Parameters<typeof po.mutateAsync>[0]);
      else if (doc === "grn") await grn.mutateAsync(body as Parameters<typeof grn.mutateAsync>[0]);
      else if (doc === "pi") await pi.mutateAsync(body as Parameters<typeof pi.mutateAsync>[0]);
      else await si.mutateAsync(body as Parameters<typeof si.mutateAsync>[0]);
      invalidateMobileLists(qc);
      onAdded();
      close();
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="st-addln" style={{ flex: "none", marginTop: 10 }} onClick={() => setOpen(true)}>
        + {ADD_LINE_LABEL}
      </button>
    );
  }

  const id = draft.itemCode ? lineIdentity({ code: draft.itemCode, description: draft.name }) : null;
  return (
    <div className="st-line" role="group" aria-label={ADD_LINE_LABEL} style={{ marginTop: 10 }}>
      <div className="lh">
        <div style={{ minWidth: 0 }}>
          <div className="sku">{ADD_LINE_LABEL}</div>
          <div className="code">{id ? id.primary : "No item picked yet"}</div>
        </div>
        <button className="x" onClick={close} aria-label="Close add line">×</button>
      </div>

      <button className="st-addln" onClick={() => setPickerOpen(true)}>
        {draft.itemCode ? "Change item" : "Pick an item"}
      </button>

      <div className="qtyrow" style={{ justifyContent: "space-between" }}>
        <div className="stepper">
          <button onClick={() => setDraft((d) => ({ ...d, qty: Math.max(1, d.qty - 1) }))} aria-label="Decrease quantity">−</button>
          <span className="q tnum" aria-label="Quantity">{draft.qty}</span>
          <button onClick={() => setDraft((d) => ({ ...d, qty: d.qty + 1 }))} aria-label="Increase quantity">+</button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--mut)" }}>
          RM
          <MoneyInput
            bare
            inputClassName="cal-sel"
            style={{ width: 110, textAlign: "right" }}
            valueSen={draft.unitPriceSen}
            onCommit={(sen) => setDraft((d) => ({ ...d, unitPriceSen: sen }))}
            allowBlank
            placeholder="0.00"
            selectOnFocus
            aria-label="Unit price"
          />
        </label>
      </div>

      {error && (
        <div className="st-warn" role="alert" style={{ whiteSpace: "pre-line" }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-ghost" style={{ height: 40, fontSize: 13 }} onClick={close}>Cancel</button>
        <button
          className="btn"
          style={{ padding: 10, fontSize: 13, opacity: blockers.length === 0 && !busy ? 1 : 0.5 }}
          disabled={blockers.length > 0 || busy}
          onClick={() => void submit()}
          title={blockers.join(" ")}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>

      {pickerOpen && <MobileSkuPicker serviceOnly={false} onPick={pick} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

export default MobileAddLine;
