/* ----------------------------------------------------------------------------
   so-list-status — the Sales Order list's TAB vocabulary and its status pills.

   Lifted out of MfgSalesOrdersListV2.tsx on 2026-08-21, which was ONE line under
   its size ceiling when the right-click menu arrived. Same move the delivery
   order made for its buckets: a self-contained vocabulary does not need to live
   inside a 2,300-line screen, and the screen cannot grow.

   THE TAB LIST IS ONE PER STATUS (页签＝状态, owner 2026-08-21), and `closed` is
   absent because CLOSED was retired from SO_STATUSES the same day. If a status
   is added to the route's vocabulary, its tab belongs here — the counts are
   generated server-side by walking that same set, so a missing row here is a
   status with a number and nowhere to show it.

   STATUS_TONE IS NOT A FULL VOCABULARY and must not be read as one. It carries
   the values that need a NON-DEFAULT colour; `statusFor` answers `neutral` plus
   the raw string for anything else, which is why a new status shows up looking
   plain rather than blank. The authoritative label map is
   vendor/scm/lib/status-pill.ts.
   ---------------------------------------------------------------------------- */

/* Every status the backend vocabulary carries (mfg-sales-orders.ts
   SO_STATUSES), in lifecycle order — the strip shows ALL of them with live
   counts so the buckets always sum to All and no order can look lost inside a
   hidden status (owner 2026-07-24: "ALL 68 but CONFIRMED 35 — where did they
   go?"). `other` is the server's catch-all for legacy/unknown spellings and
   only earns a pill when its count is non-zero. */
export type StatusTab =
  | "all"
  | "draft"
  | "confirmed"
  | "in_production"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "invoiced"
  | "on_hold"
  | "cancelled"
  | "other";


export const SO_STATUS_TABS: Array<{ value: StatusTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in_production", label: "In Production" },
  { value: "ready_to_ship", label: "Ready to Ship" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "invoiced", label: "Invoiced" },
  { value: "on_hold", label: "On Hold" },
  { value: "cancelled", label: "Cancelled" },
];


// Status → tone + label. The upstream `status` string is one of the SO
// lifecycle values plus a couple of AutoCount-legacy synonyms. Anything not
// matched falls through as neutral.
const STATUS_TONE: Record<string, { tone: "success" | "warning" | "error" | "neutral"; label: string }> = {
  draft: { tone: "warning", label: "Draft" },
  confirmed: { tone: "success", label: "Confirmed" },
  cancelled: { tone: "error", label: "Cancelled" },
  cancel: { tone: "error", label: "Cancelled" },
  invoiced: { tone: "success", label: "Invoiced" },
  delivered: { tone: "success", label: "Delivered" },
  completed: { tone: "success", label: "Completed" },
};

/* The parameter is NULLABLE, and the guards inside are why. It was typed
   `string` while the row column it reads is `status?: string | null`, so the
   `?.` and the `??` looked redundant to the compiler and to the linter while
   being the only thing standing between a null row and a crash. Widening the
   type is the honest fix — deleting the guards to satisfy the rule would have
   removed the protection and kept the bug. */
export const statusFor = (
  s: string | null | undefined,
): { tone: "success" | "warning" | "error" | "neutral"; label: string } =>
  STATUS_TONE[(s ?? "").toLowerCase()] ?? { tone: "neutral", label: s || "—" };
