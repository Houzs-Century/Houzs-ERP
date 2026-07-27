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
  | 'soAmendment' | 'soAmendmentLane' | 'poAmendment' | 'pv';

type Entry = { label: string; tone: StatusTone };

const PO: Record<string, Entry> = {
  DRAFT:              { label: 'Draft',              tone: 'pending' },
  SUBMITTED:          { label: 'Confirmed',          tone: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially Received', tone: 'progress' },
  RECEIVED:           { label: 'Received',           tone: 'success' },
  CANCELLED:          { label: 'Cancelled',          tone: 'danger' },
};
const GRN: Record<string, Entry> = {
  DRAFT:     { label: 'Draft',     tone: 'pending' },
  POSTED:    { label: 'Confirmed', tone: 'info' },
  CLOSED:    { label: 'Closed',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const PI: Record<string, Entry> = {
  DRAFT:          { label: 'Draft',          tone: 'pending' },
  POSTED:         { label: 'Confirmed',      tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'progress' },
  PAID:           { label: 'Paid',           tone: 'success' },
  VOID:           { label: 'Void',           tone: 'danger' },
  CANCELLED:      { label: 'Cancelled',      tone: 'danger' },
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
  LOADED:     { label: 'Loaded',     tone: 'info' },
  DISPATCHED: { label: 'Shipped',    tone: 'progress' },
  IN_TRANSIT: { label: 'In Transit', tone: 'progress' },
  SIGNED:     { label: 'Signed',     tone: 'success' },
  DELIVERED:  { label: 'Delivered',  tone: 'success' },
  INVOICED:   { label: 'Invoiced',   tone: 'neutral' },
  CANCELLED:  { label: 'Cancelled',  tone: 'danger' },
};
const SI: Record<string, Entry> = {
  DRAFT:          { label: 'Draft',          tone: 'pending' },
  SENT:           { label: 'Issued',         tone: 'info' },
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
  POSTED:    { label: 'Posted',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};
const STOCK_TAKE: Record<string, Entry> = {
  OPEN:      { label: 'Open',      tone: 'neutral' },
  POSTED:    { label: 'Posted',    tone: 'success' },
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

// Payment Voucher (Phase 1-B). DRAFT reads as pending; POSTED is the terminal
// happy path (posted to the GL); CANCELLED closes it (danger/red).
const PV: Record<string, Entry> = {
  DRAFT:     { label: 'Draft',     tone: 'pending' },
  POSTED:    { label: 'Posted',    tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

const MAPS: Record<StatusDocType, Record<string, Entry>> = {
  po: PO, grn: GRN, pi: PI, pr: PR,
  so: SO, do: DO, si: SI, dr: DR,
  stockTransfer: STOCK_TRANSFER, stockTake: STOCK_TAKE,
  soAmendment: SO_AMENDMENT, soAmendmentLane: SO_AMENDMENT_LANE, poAmendment: PO_AMENDMENT, pv: PV,
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
