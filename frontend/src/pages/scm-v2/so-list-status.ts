/* ----------------------------------------------------------------------------
   so-list-status — the Sales Order list's TAB vocabulary and its status pills.

   Lifted out of MfgSalesOrdersListV2.tsx on 2026-08-21, which was ONE line under
   its size ceiling when the right-click menu arrived. Same move the delivery
   order made for its buckets: a self-contained vocabulary does not need to live
   inside a 2,300-line screen, and the screen cannot grow.

   THE TAB LIST IS ONE PER STATUS (页签＝状态, owner 2026-08-21). If a status is
   added to the route's vocabulary, its tab belongs here — the counts are
   generated server-side by walking that same set, so a missing row here is a
   status with a number and nowhere to show it.

   `closed` was absent for one day, because CLOSED was retired from SO_STATUSES
   on 2026-08-21. It is back on 2026-08-22 carrying a meaning the retired one
   never had — STOP CHASING THE REMAINDER, the short-shipment case — and it sits
   after Invoiced and before On Hold: last of the states an order passes
   through, ahead of the two side states. See
   backend/src/scm/lib/so-lifecycle-guards.ts for what it means and
   so-tab-statuses.ts for why it is not folded into Delivered.

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
  | "delivered"
  | "invoiced"
  | "closed"
  | "on_hold"
  | "cancelled"
  | "other";


export const SO_STATUS_TABS: Array<{ value: StatusTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in_production", label: "In Production" },
  { value: "ready_to_ship", label: "Ready to Ship" },
  { value: "delivered", label: "Delivered" },
  { value: "invoiced", label: "Invoiced" },
  { value: "closed", label: "Closed" },
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
  /* NEUTRAL is the fall-through tone, so this row is here for the LABEL. The
     map doubles as this list's label map, and the fall-through hands back the
     RAW STORED VALUE — so without a row a closed order's pill reads "CLOSED",
     the raw enum key, which is what §1's OPEN note in
     docs/modules/document-status-vocabulary.md is about. Neutral is also the
     right tone on its own terms: closed is terminal but not a failure, the same
     reading Invoiced gets in status-pill.ts. */
  closed: { tone: "neutral", label: "Closed" },
  /* THE THREE THE OWNER WAS LOOKING AT. Until this change the list printed the
     RAW STORED VALUE for each of them — his own screenshot of production shows
     18 orders in a pill reading `READY_TO_SHIP`, underscore and all, beside
     others reading a proper "Confirmed". The fall-through below hands back
     `s`, so a status with no row here is not merely uncoloured, it is
     UNTRANSLATED.

     IN_PRODUCTION is `progress` in status-pill.ts and READY_TO_SHIP / SHIPPED
     are `success`; this list's four-tone palette has no `progress`, so
     In Production takes `warning` (the in-flight tone it already gives Draft)
     and the two ship states take `success`. The LABELS match status-pill.ts
     exactly, which is the part that must not drift.

     SHIPPED has no tab of its own — it folds into Delivered (so-tab-statuses.ts,
     2026-08-22) — and it still needs a label: folding decides which TAB a row
     appears under, not what its own pill says, and nothing writes SHIPPED today
     but the enum label is permanent. */
  in_production: { tone: "warning", label: "In Production" },
  ready_to_ship: { tone: "success", label: "Ready to Ship" },
  shipped: { tone: "success", label: "Shipped" },
  /* A LEGACY ROW ONLY, and it needs the entry precisely because it is rare.
     Nothing writes ON_HOLD to a status any more (mig 0324 made the hold a
     MARKER column with its own chip), but Postgres cannot drop an enum label,
     so a row can still arrive carrying it. Without a line here `statusFor`
     falls through to the raw string and the list prints the slug `ON_HOLD` in
     a grey pill — which is what it did for every held order between
     2026-08-21 and this change. */
  on_hold: { tone: "warning", label: "On Hold" },
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

/* ── ONE STATUS ANSWER PER ROW ──────────────────────────────────────────────
   The list used to render `statusFor(row.status)` — the STORED column — while
   the Delivered column beside it (§0.4b, #2864) rendered `shipped_qty /
   deliverable_qty`, derived LIVE from delivery-order coverage on the same
   response. One row, one question ("has this order gone out?"), two answers:
   the owner was looking at a Status cell reading In Production next to a
   Delivered cell reading 5 / 5.

   The stored column is a CACHE with exactly one writer (syncSoDeliveredFromDo),
   and that writer only ever fires from inside a delivery-order route — so an
   import script, a backfill or a hand-run SQL leaves it stale for ever, because
   nothing recomputes it on read, on a schedule, or in the database (0619).

   This resolves the pill through `soStatusDisplay`, the rule the SO detail's
   editor already uses, so the two surfaces cannot hold two opinions — and when
   the derived answer DISAGREES with the stored one, it says so instead of
   quietly picking a side. The stored value still decides which TAB counts the
   row (the tab strip is a server-side aggregate over that column), so hiding
   the disagreement would leave a row visibly filed under a tab its own pill
   contradicts.

   `deliveryState` / `lifecycleState` are OPTIONAL because a cached page from an
   older bundle carries neither, and "the payload predates the field" must read
   as "nothing derived to say" — never as "nothing has shipped". That is the
   same refusal shape shipped-progress.ts uses for its own `unknown`. */
export type SoRowStatusFields = {
  status: string;
  delivery_state?: "none" | "partial" | "full" | null;
  lifecycle_state?: "none" | "delivered" | "invoiced" | "returned" | null;
};

export type SoRowStatus = {
  tone: "success" | "warning" | "error" | "neutral";
  label: string;
  /** The STORED status this row is filed under, and only when it differs from
   *  the label above. `null` when they agree, or when nothing could be derived
   *  — so a caller renders the marker on exactly the rows that disagree. */
  storedLabel: string | null;
};

export function soRowStatus(
  row: SoRowStatusFields,
  /** The shared rule, injected so this module stays free of a vendor import and
   *  the test can prove the wiring rather than re-implement it. */
  derive: (
    status: string,
    deliveryState: "none" | "partial" | "full" | undefined,
    lifecycleState?: "none" | "delivered" | "invoiced" | "returned",
  ) => { label: string | null; classKey: string },
): SoRowStatus {
  const stored = statusFor(row.status);
  const d = derive(
    row.status,
    row.delivery_state ?? undefined,
    row.lifecycle_state ?? undefined,
  );
  /* `label: null` is soStatusDisplay saying "the stored status IS the answer" —
     a terminal state, or nothing derived. Not a disagreement. */
  if (!d.label) return { tone: stored.tone, label: stored.label, storedLabel: null };
  const tone = statusFor(d.classKey).tone;
  return {
    tone,
    label: d.label,
    storedLabel: d.label === stored.label ? null : stored.label,
  };
}
