
import type { AssrOrderPo } from "../../../shared/assr-case-pos";

/**
 * Timeline note audience buckets (mig 064 / 0108). `POST /api/assr/:id/notes`
 * accepts these four; `system` is reserved for auto-emitted events and is
 * rejected server-side, so it is deliberately absent.
 *
 * ONLY `customer` is portal-visible — every label says which side of that line
 * it falls on, because the picker is the last thing between an internal
 * remark and the customer reading it.
 */
export const ASSR_NOTE_AUDIENCES = [
  { value: "service", label: "Service (internal)" },
  { value: "customer", label: "Customer-visible" },
  { value: "supplier", label: "Supplier (internal)" },
  { value: "sales", label: "Sales (internal)" },
] as const;

/** The four stored `assr_activity.category` values a human can author. */
export type AssrNoteAudience = (typeof ASSR_NOTE_AUDIENCES)[number]["value"];

/** Is this note going to leave the building? Drives the helper line beside the
 *  picker and the textarea placeholder on both surfaces, so the two cannot
 *  disagree about which bucket is the customer-facing one. */
export function assrNoteIsCustomerVisible(audience: string): boolean {
  return audience === "customer";
}

/**
 * Issue categories — the PRE-FETCH FALLBACK only.
 *
 * `/api/assr/lookups/issue_category` is the source of truth and both surfaces
 * prefer it; this list is what they render while that request is in flight or
 * after it fails, so a create form is never a blank dropdown. Ops may add
 * categories server-side without touching this file — do NOT treat a value
 * missing from here as invalid.
 */
/** What a new case still needs, in form order. The Create button is grey until this
 *  is empty, and on a phone the empty field can be a screen away from the button. */
export const missingCaseFields = (fields: Array<[label: string, value: string]>): string[] =>
  fields.filter(([, value]) => !value.trim()).map(([label]) => label);

export const ASSR_ISSUE_CATEGORIES = [
  "Product defect",
  "Incorrect item delivered",
  "Missing / short item",
  "Warranty / service request",
  "Installation / assembly issue",
] as const;

export {
  assrOrderPos, assrOrderPoText, assrMergedPos, assrMergedPoText, type AssrOrderPo,
  assrExchangePos, assrExchangePoText, type AssrExchangePo,
} from "../../../shared/assr-case-pos";

/** The PO detail page is scoped to the tab's ACTIVE company while Service Cases
 *  are cross-company, so the link carries the case's company as the
 *  `?company=` new-window seed (lib/activeCompany.ts consumeCompanyUrlSeed). */
export function assrOrderPoHref(po: AssrOrderPo, companyId: number | null): string {
  const base = `/scm/purchase-orders/${encodeURIComponent(po.id)}`;
  return companyId != null && Number.isInteger(companyId) && companyId > 0 ? `${base}?company=${companyId}` : base;
}
