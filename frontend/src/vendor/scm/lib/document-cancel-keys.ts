/* Cancellation-approval doc types and signing keys — no imports, so a caller in
   the app shell (the sidebar's approval badge) can read them without the query
   client in document-cancel-queries.ts, which re-exports everything here. */

/** The two documents a cancellation REQUEST can sit on — the ones with
 *  `/cancel-request` routes, so the only types the hooks below accept. */
export type CancelDocType = 'so' | 'po';

/** Every document a cancellation ROW can name. The Delivery Order joined on
 *  2026-09-14 (「DO cancel need pop out window for reason」) as a reason-only
 *  document like the Purchase Order: its rows are the EXECUTED record of a
 *  cancel that already ran, and it has NO request routes — which is why it is in
 *  this type and not in CancelDocType, so no hook can be pointed at one. */
export type CancelRowDocType = CancelDocType | 'do';

export type ApprovalLevel = 1 | 2;

/** The permission that signs each level. MUST match the server's table
 *  (CANCEL_APPROVE_KEY there) — the screen only decides whether to SHOW a
 *  button; the server's 403 is the real gate. */
export const CANCEL_APPROVE_KEY: Record<CancelRowDocType, Partial<Record<ApprovalLevel, string>>> = {
  so: { 1: 'scm.so_cancel.approve_l1', 2: 'scm.so_cancel.approve_l2' },
  po: {},
  do: {},
};

/** Every key that may sign or refuse on this document type. */
export const approveKeysFor = (docType: CancelRowDocType): string[] =>
  Object.values(CANCEL_APPROVE_KEY[docType]).filter((k): k is string => typeof k === 'string');
