/* ----------------------------------------------------------------------------
   do-list-status — the Delivery Order list's TAB vocabulary and its status pills.

   Lifted out of MfgDeliveryOrdersListV2.tsx on 2026-08-21, which was one line
   over its size ceiling when the right-click menu arrived. Same move the Sales
   Order list made the same day, and the same move the buckets made server-side
   into scm/lib/do-status-buckets.ts — the three now sit at the same altitude.

   ONE BUCKET PER STATUS (页签＝状态, owner 2026-08-21). Two values map to a
   bucket that is not their own name, and both are deliberate:
     signed    -> delivered   SIGNED is merged into DELIVERED by his ruling, and
                              the enum keeps the label for ever, so a row still
                              carrying it must land somewhere and read right.
     completed -> delivered   not a member of scm.do_status at all and nothing
                              writes it; kept so such a row lands in a tab
                              instead of rendering its raw slug.

   `statusFor` answers `neutral` + the raw string for anything unlisted, which is
   why an unknown status shows up looking plain rather than blank.
   ---------------------------------------------------------------------------- */

// 页签＝状态 (owner, 2026-08-21). SIGNED has no tab — merged into DELIVERED.
export type StatusTab = "all" | "draft" | "loaded" | "dispatched" | "in_transit" | "delivered" | "invoiced" | "cancelled";

// DO lifecycle: DRAFT → LOADED → DISPATCHED → IN_TRANSIT → DELIVERED →
// INVOICED, plus CANCELLED. ONE BUCKET PER STATUS since 2026-08-21 (页签＝状态);
// SIGNED folds into `delivered` because the enum keeps the label for ever.
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  draft:       { tone: "warning", label: "Draft",       bucket: "draft" },
  loaded:      { tone: "warning", label: "Confirmed",   bucket: "loaded" },
  // "warning" (amber) doubles as the "in-transit" tone — Badge only ships
  // 4 tones (success/warning/error/neutral); the label carries the nuance.
  dispatched:  { tone: "warning", label: "Shipped",     bucket: "dispatched" },
  in_transit:  { tone: "warning", label: "In transit",  bucket: "in_transit" },
  // SIGNED: merged into DELIVERED (owner, 2026-08-21). No tab of its own.
  signed:      { tone: "success", label: "Delivered",   bucket: "delivered" },
  delivered:   { tone: "success", label: "Delivered",   bucket: "delivered" },
  invoiced:    { tone: "success", label: "Invoiced",    bucket: "invoiced" },
  // Not a do_status member; kept so such a row lands in a tab, not a raw slug.
  completed:   { tone: "success", label: "Completed",   bucket: "delivered" },
  cancelled:   { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
  cancel:      { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
};

/* Nullable for the same reason its Sales Order twin is: the column it reads is
   `status?: string | null`, and the `|| ""` inside is load-bearing. */
export const statusFor = (
  s: string | null | undefined,
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "open",
  };

/* May this delivery order still be cancelled, as far as a LIST ROW can tell?
   The two statuses `PATCH /:id/status` will never accept a cancel on: CANCELLED
   is refused outright (`do_cancelled_final`) and INVOICED is the billed end of
   the line.

   THIS IS ONLY HALF THE ROUTE'S ANSWER, and the half a row can see. The other
   refusal is `doHasDownstream` (backend/src/scm/lib/downstream-lock.ts), which
   blocks a cancel once a live Sales Invoice or Delivery Return points at the
   DO — a server-side fact no list row carries. That one reaches the operator as
   the mutation's error notice instead. See row-menus.ts.

   Null-safe by SIGNATURE, like the shared do-shipped-states predicates: the
   list's rows are a hand-written cast over an `any` payload, so a missing
   column must never reach `.toUpperCase()`. */
export const doCancellableStatus = (status: string | null | undefined): boolean => {
  const s = String(status ?? "").toUpperCase();
  return s !== "CANCELLED" && s !== "INVOICED";
};
