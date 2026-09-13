/* ------------------------------------------------------------------------- *
 * mobile-purchase-doc — the phone's DIRECT create for Purchase Order, Goods
 * Receipt and Purchase Invoice: what each document needs, and the request body
 * it sends.
 *
 * Owner 2026-09-12: 「电脑版本有的，手机版本都要有」, and the convert wizard is
 * not what he wants for creating — he wants to create directly. The desktop has
 * PurchaseOrderNew, GrnNew and PurchaseInvoiceNew; the phone had only
 * "convert from a source document".
 *
 * WHAT THIS FILE IS NOT: a second copy of any rule. It holds no validation the
 * server does not already enforce, and the one rule the desktop enforces ONLY
 * in the browser — the PO variant gate — is imported from the shared module the
 * desktop's wrapper calls, never restated:
 *
 *   desktop  PurchaseOrderNew -> SoLineCard.missingRequiredVariants
 *                             -> vendor/shared/so-variant-rule.missingVariantAxes
 *   phone    this file        -> vendor/shared/so-variant-rule.missingVariantAxes
 *
 * `missingRequiredVariants` is a one-line `.map(a => a.label)` over the same
 * function, so the answers are identical by construction and there is no name
 * here for `check-shared-mirrors` to miss.
 *
 * The other pre-checks (`createBlockers`) only decide whether the button is
 * enabled, and each one names the server refusal it mirrors. If one ever drifts,
 * the server still refuses and the screen shows the refusal — the phone never
 * becomes the authority.
 * ------------------------------------------------------------------------- */

import { missingVariantAxes } from "../vendor/shared/so-variant-rule";
import {
  canOperateGoodsReceipts,
  canOperatePurchaseInvoices,
  canOperatePurchaseOrders,
} from "../auth/salesAccess";
import type { AccessLevel } from "../types";

export type PurchaseDocKind = "po" | "grn" | "pi";

/** The mobile module lists whose "+" opens a DIRECT create. Keyed by the
 *  MobileModuleList config key (MobileApp's ROUTE_TO_CONFIG values). */
export const MODULE_TO_PURCHASE_DOC: Readonly<Record<string, PurchaseDocKind>> = {
  "mfg-purchase-orders": "po",
  grns: "grn",
  "purchase-invoices": "pi",
};

/**
 * May this user open the direct create for `kind`? One arm per document, each
 * the SAME helper the rest of the app uses for that document, and NO default
 * arm: a fourth kind that forgets its gate does not compile (MobileApp's convert
 * gate was bought with exactly that — a `: true` fall-through handed the "+" to
 * view-only holders of two documents).
 */
export function mayCreatePurchaseDoc(
  kind: PurchaseDocKind,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): boolean {
  switch (kind) {
    case "po":
      return canOperatePurchaseOrders(can, pageAccess);
    case "grn":
      return canOperateGoodsReceipts(can, pageAccess);
    case "pi":
      return canOperatePurchaseInvoices(can, pageAccess);
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** The convert flow the phone ALSO offers for this document, or null where it
 *  has none. PI from a GRN exists on desktop (PurchaseInvoiceFromGrn) and not
 *  on the phone yet. */
export function convertInsteadFor(kind: PurchaseDocKind): { target: "po" | "grn"; label: string } | null {
  switch (kind) {
    case "po":
      return { target: "po", label: "From a Sales Order instead" };
    case "grn":
      return { target: "grn", label: "From a Purchase Order instead" };
    case "pi":
      return null;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** One line on the phone form. `itemGroup` is the lowercase catalog group the
 *  SKU picker hands back — the key `missingVariantAxes` reads. */
export type PurchaseLineDraft = {
  key: string;
  itemCode: string;
  name: string;
  itemGroup: string;
  qty: number;
  /** TYPED by the operator; null until they do. Never seeded from the SKU
   *  picker: the picker's `unitPriceSen` is the catalog SELLING price, and on a
   *  purchase document that number would be booked as COST.
   *
   *  Blank rather than 0 on purpose. The shared MoneyInput refuses a keystroke
   *  that would give 3 decimals, and a "0.00" box only accepts typing once its
   *  select-on-focus (a setTimeout) has selected the text — typing that lands
   *  first is dropped keystroke by keystroke and the line saves at RM 0 with no
   *  message. Reproduced in a real 375px render 2026-09-13: "12.50" appended to
   *  "0.00" left "0.00". An empty box has nothing for a keystroke to collide
   *  with, on any browser. Sent as 0 when still blank, exactly as a desktop
   *  line with no price is. */
  unitPriceSen: number | null;
  remark: string;
};

/** The header, in one shape for all three documents. Which fields a document
 *  reads is `PURCHASE_DOC_CONFIG[kind]`; the builders below map them onto the
 *  exact names each endpoint takes. */
export type PurchaseHeaderDraft = {
  supplierId: string;
  /** PO: poDate · GRN: receivedAt · PI: invoiceDate */
  docDate: string;
  /** PO: expectedAt · PI: dueDate · GRN: not used */
  secondDate: string;
  /** PO: purchaseLocationId · GRN: warehouseId · PI: not used */
  warehouseId: string;
  /** GRN: deliveryNoteRef · PI: supplierInvoiceRef · PO: not used */
  reference: string;
  notes: string;
};

export type PurchaseDocConfig = {
  title: string;
  /** What the operator calls this document, in the success / failure message. */
  label: string;
  docDateLabel: string;
  secondDateLabel: string | null;
  /** null = this document has no warehouse on its header. */
  warehouseLabel: string | null;
  referenceLabel: string | null;
  confirmLabel: string;
};

export const PURCHASE_DOC_CONFIG: Record<PurchaseDocKind, PurchaseDocConfig> = {
  po: {
    title: "New Purchase Order",
    label: "Purchase order",
    docDateLabel: "PO date",
    secondDateLabel: "Expected delivery",
    warehouseLabel: "Purchase location",
    referenceLabel: null,
    confirmLabel: "Confirm PO",
  },
  grn: {
    title: "New Goods Receipt",
    label: "Goods receipt",
    docDateLabel: "Received on",
    secondDateLabel: null,
    warehouseLabel: "Receive into",
    referenceLabel: "Supplier delivery note",
    confirmLabel: "Receive & post",
  },
  pi: {
    title: "New Purchase Invoice",
    label: "Purchase invoice",
    docDateLabel: "Invoice date",
    secondDateLabel: "Due date",
    warehouseLabel: null,
    referenceLabel: "Supplier invoice no.",
    confirmLabel: "Confirm & post",
  },
};

/** Lines that will actually be sent: a code and a quantity above zero. The
 *  desktop pages drop blank starter lines the same way before they POST. */
export function realLines(lines: PurchaseLineDraft[]): PurchaseLineDraft[] {
  return lines.filter((l) => l.itemCode.trim() !== "" && l.qty > 0);
}

/**
 * Why the save buttons are disabled, in the operator's words. Empty = enabled.
 *
 * Each entry mirrors a refusal the SERVER already makes; none is a new rule:
 *   supplier   — PO `supplier_id_required`, GRN/PI `supplier_required`
 *   warehouse  — PO `purchase_location_id_required`, GRN `warehouse_required`
 *                (a manual GRN has no PO line to resolve one from)
 *   lines      — GRN/PI `items_required`. A PO may be saved as a blank draft
 *                server-side, but the phone form has no "add lines later"
 *                surface yet, so it asks for one line on every document.
 */
export function createBlockers(
  kind: PurchaseDocKind,
  header: PurchaseHeaderDraft,
  lines: PurchaseLineDraft[],
): string[] {
  const cfg = PURCHASE_DOC_CONFIG[kind];
  const out: string[] = [];
  if (!header.supplierId) out.push("Pick the supplier.");
  if (cfg.warehouseLabel && !header.warehouseId) out.push(`Pick the ${cfg.warehouseLabel.toLowerCase()}.`);
  if (realLines(lines).length === 0) out.push("Add at least one item with a quantity.");
  return out;
}

export type VariantGap = { itemCode: string; missing: string[] };

/**
 * The PO variant gate (owner 2026-08-20), from the SHARED rule.
 *
 * Confirming a PO needs the core options (fabric, gaps, divan / leg / seat
 * height) on every sofa and bedframe line — "the supplier cannot make it
 * without the spec". A DRAFT skips it, exactly as on desktop.
 *
 * The phone form does not capture options yet, so `variants` is `{}` and a line
 * that needs them reports every axis it needs. `itemCode` is passed, never
 * dropped, because the DIVAN ONLY and adjustable-bed exemptions key off it (the
 * parameter is required on the rule for that reason — see so-variant-rule.ts).
 */
export function poConfirmVariantGaps(lines: PurchaseLineDraft[]): VariantGap[] {
  return realLines(lines)
    .map((l) => ({
      itemCode: l.itemCode,
      missing: missingVariantAxes(l.itemGroup, {}, l.itemCode).map((a) => a.label),
    }))
    .filter((g) => g.missing.length > 0);
}

/** The operator's sentence for a refused confirm — the same words the desktop
 *  PO page uses, so a buyer who meets it on either surface reads one message. */
export function variantGapMessage(gaps: VariantGap[]): { title: string; body: string } {
  return {
    title: "Complete the product options before confirming this PO:",
    body:
      gaps.map((g) => `• ${g.itemCode}: ${g.missing.join(", ")}`).join("\n") +
      "\n\nThe supplier needs these to know what to make. (Special Orders stay optional.)" +
      "\n\nSave it as a draft now; the options are set on the purchase order on desktop.",
  };
}

const trimmedOrUndefined = (s: string): string | undefined => (s.trim() ? s.trim() : undefined);

/** POST /mfg-purchase-orders — same field names as desktop PurchaseOrderNew. */
export function buildPoPayload(header: PurchaseHeaderDraft, lines: PurchaseLineDraft[], asDraft: boolean) {
  return {
    supplierId: header.supplierId,
    currency: "MYR" as const,
    poDate: header.docDate,
    /* Blank is accepted: the API defaults it to today (owner 2026-08-20,
       "Expected Delivery must NOT block opening a PO"). */
    expectedAt: trimmedOrUndefined(header.secondDate),
    purchaseLocationId: header.warehouseId,
    notes: trimmedOrUndefined(header.notes),
    asDraft,
    items: realLines(lines).map((l) => ({
      materialKind: "mfg_product" as const,
      itemCode: l.itemCode,
      materialName: l.name || l.itemCode,
      qty: l.qty,
      unitPriceSen: l.unitPriceSen ?? 0,
      notes: trimmedOrUndefined(l.remark),
      itemGroup: l.itemGroup || undefined,
      soItemId: null,
    })),
  };
}

/** POST /grns — a MANUAL receipt (no PO behind it), same names as GrnNew. */
export function buildGrnPayload(header: PurchaseHeaderDraft, lines: PurchaseLineDraft[], asDraft: boolean) {
  return {
    purchaseOrderId: null,
    supplierId: header.supplierId,
    asDraft,
    warehouseId: header.warehouseId,
    receivedAt: header.docDate,
    deliveryNoteRef: trimmedOrUndefined(header.reference),
    notes: trimmedOrUndefined(header.notes),
    currency: "MYR",
    exchangeRate: 1,
    items: realLines(lines).map((l) => ({
      purchaseOrderItemId: null,
      materialKind: "mfg_product",
      itemCode: l.itemCode,
      materialName: l.name || l.itemCode,
      qtyReceived: l.qty,
      /* GrnNew: "accepted follows received (rejected 0)". */
      qtyAccepted: l.qty,
      qtyRejected: 0,
      unitPriceSen: l.unitPriceSen ?? 0,
      notes: trimmedOrUndefined(l.remark),
      itemGroup: l.itemGroup || undefined,
    })),
  };
}

/** POST /purchase-invoices — a MANUAL invoice (no GRN / PO behind it), same
 *  names as PurchaseInvoiceNew. */
export function buildPiPayload(header: PurchaseHeaderDraft, lines: PurchaseLineDraft[], asDraft: boolean) {
  return {
    supplierId: header.supplierId,
    purchaseOrderId: null,
    grnId: null,
    supplierInvoiceRef: trimmedOrUndefined(header.reference),
    invoiceDate: header.docDate,
    dueDate: trimmedOrUndefined(header.secondDate),
    notes: trimmedOrUndefined(header.notes),
    asDraft,
    currency: "MYR",
    exchangeRate: 1,
    items: realLines(lines).map((l) => ({
      grnItemId: null,
      materialKind: "mfg_product",
      itemCode: l.itemCode,
      materialName: l.name || l.itemCode,
      qty: l.qty,
      unitPriceSen: l.unitPriceSen ?? 0,
      notes: trimmedOrUndefined(l.remark),
      itemGroup: l.itemGroup || undefined,
    })),
  };
}
