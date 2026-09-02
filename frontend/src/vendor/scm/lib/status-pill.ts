// Canonical status → {label, tone} maps for every ERP document type, plus the
// tone palette. ONE source of truth so a status looks + reads identically on
// every list, detail and drill-down (Commander 2026-06-18 — "统一 UI/范例").
//
// Background tints are lifted verbatim from the pre-existing list/detail pills
// so adoption is visually conservative (same colours, just centralised); the
// only deliberate change is that list pills now also tint the TEXT (tone.fg),
// matching what the detail pages already did.
//
// Lifecycle note: SO / DO / SI also carry a document-driven "effective" status
// (see lib/so-status.ts soStatusDisplay / doEffectiveKey). Those callers must
// resolve the effective raw status FIRST, then pass it here.

/* ONE WORD FOR "THIS DOCUMENT IS NOW REAL" (owner ruling, 2026-08-21).
 *
 * His question: 「为什么会有这么多不一样的名词」. The step where a document stops
 * being a draft and becomes committed is STORED under five different words —
 * CONFIRMED (SO), SUBMITTED (PO), POSTED (GRN / PI / PR / stock transfer /
 * stock take / PV), SENT (SI), LOADED (DO) — because each document type was
 * written at a different time. This layer already translated three of them and
 * stopped there, so the screen said "Confirmed" on a purchase order and
 * "Posted" on a stock transfer for the identical act.
 *
 * He chose option A: change the WORD, never the stored value. Every one of
 * those states now reads **Confirmed**. The database is untouched, so
 * AutoCount, every report and every historical document are unaffected — which
 * is the whole reason A was recommended over renaming the columns.
 *
 * WHAT DELIBERATELY KEEPS ITS OWN WORD, because it is a DIFFERENT event and not
 * a second name for this one:
 *   DO  DISPATCHED = "Loaded"   — the goods are physically on the lorry. LOADED
 *       is the delivery order's confirm step and reads "Confirmed"; since
 *       2026-08-22 it is ALSO where the inventory OUT fires (owner: confirming a
 *       delivery order is what takes the stock out). DISPATCHED keeps its own
 *       word because it is still a different event: CONFIRMED is the paperwork,
 *       Loaded is the pallet on the truck, In Transit is the truck moving.
 *
 *       THE LABEL WAS "Shipped" UNTIL 2026-08-26. The owner asked where dispatch
 *       sits — 「dispatch就是出发了啊?」 — and the honest answer was that it does
 *       not: on the three-scan flow he settled the same week, the storekeeper's
 *       scan writes DISPATCHED when the goods go ON the lorry, and DEPARTURE is
 *       the driver's next scan (IN_TRANSIT). "Shipped" claimed the truck had
 *       left. The STORED value is untouched and stays `DISPATCHED` for ever —
 *       Postgres enum labels are permanent and every report reads the stored
 *       value — so this is the same option A as the Confirmed sweep above.
 *   SI  PAID / PARTIALLY_PAID   — money, not commitment.
 *   PO  PARTIALLY_RECEIVED / RECEIVED — progress, not commitment.
 *
 * Adding a document type to this file? Its confirm step reads "Confirmed". */
export type StatusTone = 'neutral' | 'info' | 'progress' | 'success' | 'danger' | 'pending';

export const STATUS_TONES: Record<StatusTone, { bg: string; fg: string }> = {
  neutral:  { bg: 'rgba(34, 31, 32, 0.08)',   fg: 'var(--fg-muted)' },
  info:     { bg: 'rgba(166, 71, 30, 0.12)',  fg: 'var(--c-burnt)' },
  progress: { bg: 'rgba(166, 71, 30, 0.18)',  fg: 'var(--c-burnt)' },
  success:  { bg: 'rgba(47, 93, 79, 0.28)',   fg: 'var(--c-secondary-a, #2F5D4F)' },
  danger:   { bg: 'rgba(184, 51, 31, 0.10)',  fg: 'var(--c-festive-b, #B8331F)' },
  pending:  { bg: 'rgba(214, 158, 46, 0.18)', fg: '#8a5a00' },
};

export type StatusDocType =
  | 'po' | 'grn' | 'pi' | 'pr'
  | 'so' | 'do' | 'si' | 'dr'
  | 'stockTransfer' | 'stockTake'
  | 'soAmendment' | 'soAmendmentLane' | 'poAmendment' | 'pv'
  | 'dpOrder';

type Entry = { label: string; tone: StatusTone };

const PO: Record<string, Entry> = {
  DRAFT:              { label: 'Draft',              tone: 'pending' },
  SUBMITTED:          { label: 'Confirmed',          tone: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially Received', tone: 'progress' },
  RECEIVED:           { label: 'Received',           tone: 'success' },
  CANCELLED:          { label: 'Cancelled',          tone: 'danger' },
  ON_HOLD:            { label: 'On Hold',            tone: 'pending' },
};
const GRN: Record<string, Entry> = {
  DRAFT:     { label: 'Draft',     tone: 'pending' },
  POSTED:    { label: 'Confirmed', tone: 'info' },
  CLOSED:    { label: 'Closed',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
  ON_HOLD:   { label: 'On Hold',   tone: 'pending' },
};
const PI: Record<string, Entry> = {
  DRAFT:          { label: 'Draft',          tone: 'pending' },
  POSTED:         { label: 'Confirmed',      tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'progress' },
  PAID:           { label: 'Paid',           tone: 'success' },
  VOID:           { label: 'Void',           tone: 'danger' },
  CANCELLED:      { label: 'Cancelled',      tone: 'danger' },
  ON_HOLD:        { label: 'On Hold',        tone: 'pending' },
};
const PR: Record<string, Entry> = {
  POSTED:    { label: 'Confirmed', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const SO: Record<string, Entry> = {
  DRAFT:         { label: 'Draft',         tone: 'pending' },
  CONFIRMED:     { label: 'Confirmed',     tone: 'info' },
  IN_PRODUCTION: { label: 'Proceed',       tone: 'progress' },
  READY_TO_SHIP: { label: 'Ready to Ship', tone: 'success' },
  SHIPPED:       { label: 'Shipped',       tone: 'success' },
  DELIVERED:     { label: 'Delivered',     tone: 'success' },
  INVOICED:      { label: 'Invoiced',      tone: 'neutral' },
  CLOSED:        { label: 'Closed',        tone: 'neutral' },
  ON_HOLD:       { label: 'On Hold',       tone: 'progress' },
  RETURNED:      { label: 'Returned',      tone: 'pending' },
  CANCELLED:     { label: 'Cancelled',     tone: 'danger' },
};
const DO: Record<string, Entry> = {
  DRAFT:      { label: 'Draft',      tone: 'pending' },
  LOADED:     { label: 'Confirmed',  tone: 'info' },
  DISPATCHED: { label: 'Loaded',     tone: 'progress' },
  IN_TRANSIT: { label: 'In Transit', tone: 'progress' },
  SIGNED:     { label: 'Signed',     tone: 'success' },
  DELIVERED:  { label: 'Delivered',  tone: 'success' },
  INVOICED:   { label: 'Invoiced',   tone: 'neutral' },
  CANCELLED:  { label: 'Cancelled',  tone: 'danger' },
};
const SI: Record<string, Entry> = {
  DRAFT:          { label: 'Draft',          tone: 'pending' },
  SENT:           { label: 'Confirmed',      tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'progress' },
  PAID:           { label: 'Paid',           tone: 'success' },
  OVERDUE:        { label: 'Overdue',        tone: 'danger' },
  VOID:           { label: 'Void',           tone: 'danger' },
  CANCELLED:      { label: 'Cancelled',      tone: 'danger' },
};
const DR: Record<string, Entry> = {
  PENDING:      { label: 'Pending',      tone: 'info' },
  RECEIVED:     { label: 'Received',     tone: 'success' },
  INSPECTED:    { label: 'Inspected',    tone: 'success' },
  REFUNDED:     { label: 'Refunded',     tone: 'success' },
  CREDIT_NOTED: { label: 'Credit Noted', tone: 'success' },
  REJECTED:     { label: 'Rejected',     tone: 'danger' },
  CANCELLED:    { label: 'Cancelled',    tone: 'danger' },
};
const STOCK_TRANSFER: Record<string, Entry> = {
  POSTED:    { label: 'Confirmed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const STOCK_TAKE: Record<string, Entry> = {
  OPEN:      { label: 'Open',      tone: 'neutral' },
  POSTED:    { label: 'Confirmed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

// SO amendment / revision workflow (Phase 1-C). Two-gate state machine:
// REQUESTED → SUPPLIER_PENDING → SO_APPROVED → PO_APPROVED → SENT / REJECTED.
// The two mid-gates read as in-progress (progress/burnt); SENT is the terminal
// happy path (success/green); REJECTED closes it (danger/red).
const SO_AMENDMENT: Record<string, Entry> = {
  REQUESTED:        { label: 'Requested',         tone: 'info' },
  SUPPLIER_PENDING: { label: 'Supplier Pending',  tone: 'pending' },
  SO_APPROVED:      { label: 'SO Approved',        tone: 'progress' },
  PO_APPROVED:      { label: 'PO Approved',        tone: 'progress' },
  SENT:             { label: 'Sent',               tone: 'success' },
  REJECTED:         { label: 'Rejected',           tone: 'danger' },
};

// Two-lane rework (2026-07-27): a LANE amendment (so_amendments.lane set) has
// ONE signature — REQUESTED -> SO_APPROVED is its applied TERMINAL, so it reads
// "Applied" (success), not the legacy mid-chain "SO Approved" (progress).
const SO_AMENDMENT_LANE: Record<string, Entry> = {
  REQUESTED:   { label: 'Requested', tone: 'info' },
  SO_APPROVED: { label: 'Applied',   tone: 'success' },
  REJECTED:    { label: 'Rejected',  tone: 'danger' },
};

// PO amendment / revision workflow (Houzs, mig 0192). SIMPLIFIED single-approver
// state machine: REQUESTED -> APPROVED, with REJECTED the terminal close for both
// a rejection and a withdrawal. REQUESTED reads as in-flight (info/burnt); APPROVED
// is the terminal happy path (success/green); REJECTED closes it (danger/red).
const PO_AMENDMENT: Record<string, Entry> = {
  REQUESTED: { label: 'Requested', tone: 'info' },
  APPROVED:  { label: 'Approved',  tone: 'success' },
  REJECTED:  { label: 'Rejected',  tone: 'danger' },
};

// Payment Voucher. The owner's four layers (2026-09-02): Draft → Prepared →
// Checked → Approved — the middle two live as MARKS on a DRAFT row (the list
// says them beside the pill), and POSTED is what the second yes leaves
// behind, so its label is the owner's word for it: Approved. CANCELLED
// closes it (danger/red).
const PV: Record<string, Entry> = {
  DRAFT:     { label: 'Draft',    tone: 'pending' },
  POSTED:    { label: 'Approved', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

// DP Order (delivery-planning job, mig 0129). PENDING_SCHEDULE is the whole
// reason the DP Orders list exists (awaiting a lorry + date to mint its DP
// number); SCHEDULED is the terminal happy path; CANCELLED closes it.
const DP_ORDER: Record<string, Entry> = {
  PENDING_SCHEDULE: { label: 'Pending Schedule', tone: 'pending' },
  SCHEDULED:        { label: 'Scheduled',        tone: 'success' },
  CANCELLED:        { label: 'Cancelled',        tone: 'danger' },
};

const MAPS: Record<StatusDocType, Record<string, Entry>> = {
  po: PO, grn: GRN, pi: PI, pr: PR,
  so: SO, do: DO, si: SI, dr: DR,
  stockTransfer: STOCK_TRANSFER, stockTake: STOCK_TAKE,
  soAmendment: SO_AMENDMENT, soAmendmentLane: SO_AMENDMENT_LANE, poAmendment: PO_AMENDMENT, pv: PV,
  dpOrder: DP_ORDER,
};

const titleCase = (raw: string): string =>
  raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Humanise a raw enum key for a surface that has NO canonical map for its
 *  document type — `PARTIALLY_RECEIVED` -> "Partially Received". The same
 *  transform resolveStatusPill already falls back to; exported so a caller
 *  never has to print the raw key (owner 2026-07-16: 白話文). Prefer
 *  statusLabel() whenever the docType IS mapped — this is the last resort. */
export const humaniseStatusKey = (status: string | null | undefined): string =>
  status ? titleCase(String(status)) : '—';

/** Resolve a raw status to its canonical {label, tone}. Unknown → neutral
 *  with a humanised label, so a new enum value never renders blank or raw.
 *  `MAPS[docType]?.` — an unmapped docType must degrade to the humanised
 *  label, not throw on undefined[s]. */
export function resolveStatusPill(docType: StatusDocType, status: string | null | undefined): Entry {
  const s = String(status ?? '').toUpperCase();
  return MAPS[docType]?.[s] ?? { label: humaniseStatusKey(status), tone: 'neutral' };
}

/** Canonical human label only — for DataGrid searchValue / groupValue / filter
 *  chips, where the pill JSX isn't wanted but the text must match. */
export function statusLabel(docType: StatusDocType, status: string | null | undefined): string {
  return resolveStatusPill(docType, status).label;
}

/** Every status this document type's canonical map carries. Exported so a
 *  caller that must cover a WHOLE vocabulary — the printed-document label test
 *  is the one today — enumerates it from here instead of re-typing the list.
 *  A hand-copied vocabulary is the drift this file exists to stop, and the copy
 *  in a test is the one nobody notices has gone stale. */
export function statusVocabulary(docType: StatusDocType): string[] {
  return Object.keys(MAPS[docType]);
}

// ── Simplified amendment status buckets (owner 2026-07-24) ───────────────────
// The amendment LIST surfaces (SO + PO queues, desktop + mobile) collapse to just
// Requested / Approved / All. The SO amendment backend still carries the granular
// two-gate enum (SUPPLIER_PENDING / SO_APPROVED / PO_APPROVED / SENT) that the
// 2990 mirror + the SO detail stepper depend on — so this ONLY changes what the
// list shows, never the stored value. The PO amendment enum already IS the
// simplified set (REQUESTED / APPROVED / REJECTED), so its buckets are identity.
//
//   REQUESTED bucket = still open / in-flight (REQUESTED, SUPPLIER_PENDING)
//   APPROVED  bucket = applied            (SO_APPROVED, PO_APPROVED, SENT, APPROVED)
//   REJECTED  bucket = closed w/o applying (REJECTED — reached via the All chip)
export type AmendmentBucket = 'REQUESTED' | 'APPROVED' | 'REJECTED';

const APPLIED_STATES = ['SO_APPROVED', 'PO_APPROVED', 'SENT', 'APPROVED'];

/** Collapse any SO/PO amendment status to its simplified list bucket. */
export const amendmentBucketOf = (status: string | null | undefined): AmendmentBucket => {
  const s = String(status ?? '').toUpperCase();
  if (s === 'REJECTED') return 'REJECTED';
  if (APPLIED_STATES.includes(s)) return 'APPROVED';
  return 'REQUESTED';
};

const BUCKET_ENTRY: Record<AmendmentBucket, Entry> = {
  REQUESTED: { label: 'Requested', tone: 'info' },
  APPROVED:  { label: 'Approved',  tone: 'success' },
  REJECTED:  { label: 'Rejected',  tone: 'danger' },
};

/** The simplified {label, tone} an amendment LIST row shows — one of exactly
 *  Requested / Approved / Rejected, regardless of the granular backend status. */
export const simplifiedAmendmentPill = (status: string | null | undefined): Entry =>
  BUCKET_ENTRY[amendmentBucketOf(status)];

/** The simplified filter chips every amendment list uses. */
export const AMENDMENT_LIST_CHIPS = ['all', 'REQUESTED', 'APPROVED'] as const;
export const amendmentBucketLabel = (bucket: string): string =>
  bucket === 'all' ? 'All' : (BUCKET_ENTRY[bucket as AmendmentBucket]?.label ?? bucket);
