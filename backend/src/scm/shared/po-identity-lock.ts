/* The PO header's PARTIAL lock — the purchase-side mirror of so-identity-lock.
 * Extracted so the rule reads and tests without a Hono context or a database.
 *
 * Owner 2026-08-20 ("越松越好" / §8 GAP-1 of the workflow-unification spec). The
 * PO header used to freeze WHOLESALE the moment a non-cancelled GRN existed:
 * `poHasDownstream` → 409 on the entire PATCH, so a PO whose goods had been
 * received could not even fix a supplier remark or push a delivery date. Every
 * other parent over-froze this way; only the SO modelled field-level inheritance
 * (SO_IDENTITY_LOCK_COLS). This brings the PO in line.
 *
 * A GRN snapshots WHAT was ordered, FROM WHOM, IN WHICH CURRENCY, and INTO WHICH
 * location. Those header columns are inherited → frozen once a GRN exists; to
 * change one, cancel the GRN (which reverses the stock) and edit the PO, then
 * re-receive. The PO's OWN-stage fields — its dates, notes and supplier-revised
 * delivery dates — never reach the GRN, so they stay editable. Keyed by DB
 * column name.
 *
 * Lines are a separate, deliberately WHOLESALE lock (add/edit/delete a PO line
 * is refused once a GRN exists): a line IS what was ordered, and you cannot
 * change what was ordered after it has been received. That lock is unchanged. */
import { PO_LOCK_COLS } from './document-policy';

/* The columns (supplier / currency / purchase location — the GRN's basis) come
   from the ONE rulebook (document-policy.ts) so this set can't drift from the
   registry or its siblings. Re-exported here for the route + tests that import it. */
export const PO_IDENTITY_LOCK_COLS: ReadonlySet<string> = PO_LOCK_COLS;

/** Loose equality mirroring the SO lock's `norm()` — null / undefined / '' all
    collapse, so a form re-sending a blank field as '' does not read as a change
    from null. */
const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The inherited columns this patch genuinely CHANGES (the 409 list). Empty when
    the patch only touches PO-own fields — which then saves even with a GRN. */
export function changedPoIdentityLockCols(
  updates: Record<string, unknown>,
  beforeRow: Record<string, unknown>,
): string[] {
  return [...PO_IDENTITY_LOCK_COLS].filter(
    (col) => col in updates && norm(updates[col]) !== norm(beforeRow[col]),
  );
}

/** The 409 body when a header PATCH tries to move an inherited field on a PO
    that already has a GRN. Names the fields and the cancel-to-source remedy. */
export function poIdentityLockedRefusal(cols: string[]) {
  const label: Record<string, string> = {
    supplier_id: 'supplier',
    currency: 'currency',
    purchase_location_id: 'purchase location',
  };
  const names = cols.map((c) => label[c] ?? c);
  return {
    error: 'po_identity_locked',
    message:
      `The ${names.join(', ')} on this PO is already reflected in a Goods Receipt, so it `
      + 'cannot be changed here. To change it, cancel the GRN (that reverses the received '
      + 'stock) and edit the PO, then receive it again. Its dates and notes are still editable.',
    fields: cols,
  };
}
