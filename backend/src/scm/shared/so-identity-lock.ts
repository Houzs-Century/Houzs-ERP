/* The SO header's partial lock, extracted from mfg-sales-orders.ts so the rule
   can be read and tested without a Hono context, a database, or a 12,000-line
   scroll. The route imports these; nothing else about the lock moved. */

/* Owner 2026-05-31 — Identity + value columns a downstream DO / SI snapshots.
   These are frozen on the SO header once a non-cancelled child exists; payment,
   remark and scheduling columns are intentionally NOT in this set so the shop
   can still record payment after delivery. Keyed by DB column name.

   NOT `salesperson_id` (Owner 2026-08-17). It sat here from the start and the
   lock was collateral damage: a DO / SI snapshots the customer, the addresses
   and the money — never WHO SOLD IT. Freezing it meant a resigning
   salesperson's delivered orders could not be handed to their replacement, and
   the replacement could not even SEE them, because SO row-level visibility keys
   off this very column. It is now gated rather than frozen: only
   `scm.so.attribute_other` may move it (see salespersonReattributed). */
export const SO_IDENTITY_LOCK_COLS: ReadonlySet<string> = new Set<string>([
  'debtor_code', 'debtor_name', 'agent', 'sales_location', 'ref', 'po_doc_no',
  'venue', 'venue_id', 'branding', 'address1', 'address2', 'address3', 'address4',
  'phone', 'currency', 'so_date', 'customer_id', 'customer_state', 'customer_po',
  'customer_po_id', 'customer_po_date', 'customer_po_image_b64', 'customer_so_no',
  'hub_id', 'hub_name', 'ship_to_address', 'bill_to_address', 'install_to_address',
  'email', 'customer_type', 'city', 'postcode', 'building_type',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
]);

/** Loose equality mirroring the route's `norm()` — null / undefined / '' all
    collapse, so a form re-sending a blank field as '' does not read as a
    change from null. */
const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** True when this patch genuinely moves the order to a different salesperson
    (not a UI re-send of the same id). The caller turns that into the
    `scm.so.attribute_other` permission check. */
export function salespersonReattributed(
  updates: Record<string, unknown>,
  beforeRow: Record<string, unknown>,
): boolean {
  return 'salesperson_id' in updates
    && norm(updates['salesperson_id']) !== norm(beforeRow['salesperson_id']);
}

/** Locked columns this patch genuinely changes — the 409 list.

    `agentFollowedSalesperson` is the one exemption. `agent` (the AutoCount rep
    NAME) is locked, and so-agent.ts makes it follow a reassigned salesperson
    automatically. Without the exemption the 2026-08-17 salesperson unlock would
    be dead on arrival: handing over a delivered order writes the new rep's name
    into `agent` too, and the lock would 409 on THAT instead. An `agent` the
    client authored itself never sets the flag, so it stays locked. */
export function changedIdentityLockCols(
  updates: Record<string, unknown>,
  beforeRow: Record<string, unknown>,
  opts: { agentFollowedSalesperson?: boolean } = {},
): string[] {
  return [...SO_IDENTITY_LOCK_COLS].filter(
    (col) =>
      col in updates
      && norm(updates[col]) !== norm(beforeRow[col])
      && !(col === 'agent' && opts.agentFollowedSalesperson),
  );
}
