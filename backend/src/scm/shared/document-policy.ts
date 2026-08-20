/* document-policy.ts — the transaction workflow's ONE header-edit rulebook.
 *
 * Owner 2026-08-20: consolidate the per-document "which header columns freeze once
 * a downstream child exists" rules into a single registry, so a rule is defined in
 * ONE place and cannot drift out of sync between sibling documents (the exact
 * defect that shipped the GRN + PC-Receive header holes). This is the shared
 * "engine": every transaction document's header edit asks THIS for its lock, and
 * check-workflow-consistency.mjs fails CI if a document is not wired to it.
 *
 * Behaviour is PRESERVED, not changed: each policy below carries the same lock
 * columns + error code the document already used, so the migration is a move, not
 * a rule change (proven by each doc's existing *HeaderFieldLock test).
 *
 * SO and CO are SPECIALIZED and stay in their own modules (so-identity-lock.ts —
 * carries the salesperson-attribution exemption; consignment-order-shape.ts). They
 * are the sales-order-shaped documents with the broad 34-column identity set and
 * bespoke decision logic; folding them into this uniform shape would risk those
 * nuances. They are REGISTERED here for the rulebook view + the gate, and keep
 * their own decision functions. */

import { changedLockedCols, identityLockedRefusal } from './header-inherited-lock';

export type TxnDocType = 'PO' | 'GRN' | 'DO' | 'CN' | 'PCO' | 'PC_RECEIVE';

export type HeaderLockPolicy = {
  /** Inherited columns that freeze once a live child exists (DB column names). */
  lockCols: ReadonlySet<string>;
  labels: Record<string, string>;
  /** The 409 error code — UNCHANGED per document. */
  error: string;
  what: string;
  child: string;
  ownFields: string;
};

/* The per-document lock column sets + labels — the single source. Each document's
   lock module/route imports ITS set from here, so "which columns freeze" lives in
   exactly one place. UNCHANGED from what each document already used. */
const SUPPLIER_LABELS = { supplier_id: 'supplier', currency: 'currency', purchase_location_id: 'purchase location' };
const CUSTOMER_LABELS = { debtor_code: 'customer code', debtor_name: 'customer', currency: 'currency', sales_location: 'sales location', branding: 'branding' };

export const PO_LOCK_COLS: ReadonlySet<string> = new Set(['supplier_id', 'currency', 'purchase_location_id']);
export const GRN_LOCK_COLS: ReadonlySet<string> = new Set(['supplier_id', 'currency', 'exchange_rate', 'allocation_method']);
export const DO_LOCK_COLS: ReadonlySet<string> = new Set(['debtor_code', 'debtor_name', 'currency', 'sales_location', 'branding']);
export const CN_LOCK_COLS: ReadonlySet<string> = DO_LOCK_COLS;
export const PCO_LOCK_COLS: ReadonlySet<string> = PO_LOCK_COLS;
export const PCR_LOCK_COLS: ReadonlySet<string> = new Set(['supplier_id', 'currency']);

export const GRN_LOCK_LABELS: Record<string, string> = { supplier_id: 'supplier', currency: 'currency', exchange_rate: 'exchange rate', allocation_method: 'cost allocation method' };
export const DO_LOCK_LABELS: Record<string, string> = CUSTOMER_LABELS;
export const CN_LOCK_LABELS: Record<string, string> = CUSTOMER_LABELS;
export const PCO_LOCK_LABELS: Record<string, string> = SUPPLIER_LABELS;
export const PCR_LOCK_LABELS: Record<string, string> = { supplier_id: 'supplier', currency: 'currency' };
export const PO_LOCK_LABELS: Record<string, string> = SUPPLIER_LABELS;

export const TXN_HEADER_LOCK: Record<TxnDocType, HeaderLockPolicy> = {
  PO:  { lockCols: PO_LOCK_COLS,  labels: PO_LOCK_LABELS,  error: 'po_identity_locked',          what: 'Purchase Order',             child: 'Goods Receipt',                        ownFields: 'dates and notes' },
  GRN: { lockCols: GRN_LOCK_COLS, labels: GRN_LOCK_LABELS, error: 'grn_header_inherited_locked', what: 'GRN',                        child: 'Purchase Invoice or Purchase Return',  ownFields: 'received date, delivery-note ref, warehouse and notes' },
  DO:  { lockCols: DO_LOCK_COLS,  labels: DO_LOCK_LABELS,  error: 'do_identity_locked',          what: 'Delivery Order',             child: 'Sales Invoice or Delivery Return',     ownFields: 'delivery dates, dispatch details, addresses and notes' },
  CN:  { lockCols: CN_LOCK_COLS,  labels: CN_LOCK_LABELS,  error: 'cn_identity_locked',          what: 'Consignment Note',           child: 'Consignment Return',                   ownFields: 'delivery dates, dispatch details and notes' },
  PCO: { lockCols: PCO_LOCK_COLS, labels: PCO_LOCK_LABELS, error: 'pco_identity_locked',         what: 'Purchase-Consignment Order', child: 'PC Receive',                           ownFields: 'dates and notes' },
  PC_RECEIVE: { lockCols: PCR_LOCK_COLS, labels: PCR_LOCK_LABELS, error: 'pc_receive_identity_locked', what: 'PC Receive',            child: 'PC Return',                            ownFields: 'received date, delivery-note ref and notes' },
};

/** The inherited columns a header patch genuinely changes, per the doc's policy.
 *  `updates` is the snake-keyed, already-normalised column map the route writes. */
export function changedHeaderLockCols(
  doc: TxnDocType,
  updates: Record<string, unknown>,
  before: Record<string, unknown>,
): string[] {
  return changedLockedCols(TXN_HEADER_LOCK[doc].lockCols, updates, before);
}

/** The 409 body for a locked header edit, built from the doc's policy. */
export function headerLockRefusal(doc: TxnDocType, cols: string[]) {
  const p = TXN_HEADER_LOCK[doc];
  return identityLockedRefusal({
    error: p.error, fields: cols, labels: p.labels,
    what: p.what, child: p.child, ownFields: p.ownFields,
  });
}
