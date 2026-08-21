// ----------------------------------------------------------------------------
// assr/case-fields — the ASSR case vocabularies that are NOT the stage pipeline:
// who a timeline note is addressed to, and the issue-category fallback list.
// NO React, no query client, no I/O — same contract as ./stages.
//
// WHY THIS FILE EXISTS. Both lists were written out twice, once on the desktop
// page and once on the mobile screen, and one pair had ALREADY drifted:
//
//   · NOTE AUDIENCE — desktop's <option>s read "Service (internal)",
//     "Customer-visible", "Supplier (internal)", "Sales (internal)"; mobile's
//     `NOTE_AUDIENCE_OPTIONS` read "Service", "Customer", "Supplier", "Sales".
//     Same four stored values, two different promises. This is the label a
//     person reads while deciding whether a CUSTOMER will see what they are
//     about to type, so "Customer" and "Customer-visible" are not stylistic
//     variants of each other — one states the consequence and the other leaves
//     the reader to guess it. The explicit wording wins here.
//   · ISSUE CATEGORY — the same five strings on both surfaces. In sync on the
//     day this file was written, which is the only interesting thing about it:
//     the drift above is what the second copy does eventually, not immediately.
//
// The stored VALUES are the server's, not ours: `NOTE_CATEGORIES`
// (backend/src/routes/assr.ts) accepts exactly these four and coerces anything
// else to "service", and only `customer` is visible outside the team (portal).
// Change a value here and the note silently lands in the wrong bucket.
// ----------------------------------------------------------------------------

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
export const ASSR_ISSUE_CATEGORIES = [
  "Product defect",
  "Incorrect item delivered",
  "Missing / short item",
  "Warranty / service request",
  "Installation / assembly issue",
] as const;
