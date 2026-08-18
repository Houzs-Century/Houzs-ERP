/* Consignment Order column lists, the finance gate, and the photo-upload
 * constants — the inert half of routes/consignment-orders.ts.
 *
 * WHY THEY MOVED. That router was 70 lines over its size ceiling. None of this
 * is logic anyone reasons about while reading a handler: it is the SELECT lists,
 * the finance-key set, and two upload constants. Moving them is provably
 * behaviour-preserving — the values are byte-identical and nothing here reads
 * request state.
 *
 * WHAT IS DELIBERATELY STILL LOCAL. The four helpers that DERIVE something —
 * deriveCountryFromState, deriveSalesLocationFromState, snapshotUnitCostSen and
 * normCategory — each have a twin in mfg-sales-orders.ts, and three of the four
 * pairs DIFFER. They are not consolidated here because unifying them changes
 * behaviour, and which version is right is a question for the owner, not a
 * refactor. The differences are written up in BUG-HISTORY.md (2026-08-15).
 */
import { canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
export const HEADER =
  'doc_no, transfer_to, so_date, branding, debtor_code, debtor_name, agent, sales_location, ref, po_doc_no, venue, venue_id, ' +
  'address1, address2, address3, address4, phone, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, local_total_centi, balance_centi, ' +
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, ' +
  'total_cost_centi, total_revenue_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  /* See "WHY A CONSTANT" in shared/so-processing-date.ts. */
  'currency, status, remark2, remark3, remark4, note, sales_exemption_expiry, ' +
  'customer_id, customer_po, customer_po_id, customer_po_date, customer_po_image_b64, customer_so_no, hub_id, hub_name, ' +
  'customer_state, customer_country, customer_delivery_date, processing_date, linked_do_doc_no, ' +
  'ship_to_address, bill_to_address, install_to_address, subtotal_sen, overdue, ' +
  'email, customer_type, salesperson_id, city, postcode, building_type, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'payment_method, installment_months, merchant_provider, approval_code, payment_date, deposit_centi, paid_centi, ' +
  'created_at, created_by, updated_at';
export const ITEM =
  'id, doc_no, line_date, debtor_code, debtor_name, agent, item_group, item_code, description, description2, ' +
  'uom, location, qty, unit_price_centi, discount_centi, total_centi, tax_centi, total_inc_centi, balance_centi, ' +
  'payment_status, venue, branding, remark, cancelled, variants, unit_cost_centi, line_cost_centi, line_margin_centi, ' +
  'line_delivery_date, line_delivery_date_overridden, ' +
  'photo_urls, ' +
  'created_at';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

export const extFromMime = (mime: string): string => {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  if (m === 'image/gif')                       return 'gif';
  if (m === 'image/heic')                      return 'heic';
  if (m === 'image/heif')                      return 'heif';
  if (m === 'image/avif')                      return 'avif';
  if (m.startsWith('image/'))                  return 'bin';
  return '';
};

export const CO_IDENTITY_LOCK_COLS = new Set<string>([
  'debtor_code', 'debtor_name', 'agent', 'sales_location', 'ref', 'po_doc_no',
  'venue', 'venue_id', 'branding', 'address1', 'address2', 'address3', 'address4',
  'phone', 'currency', 'so_date', 'customer_id', 'customer_state', 'customer_po',
  'customer_po_id', 'customer_po_date', 'customer_po_image_b64', 'customer_so_no',
  'hub_id', 'hub_name', 'ship_to_address', 'bill_to_address', 'install_to_address',
  'email', 'customer_type', 'salesperson_id', 'city', 'postcode', 'building_type',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
]);

/* Loose equality for the lock diff — null / undefined / '' all collapse. */
export function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/* FINANCE-GATED header keys — cost / margin / per-category revenue+cost
   subtotals + deposit. All are in HEADER (so they travel in the CO list AND
   detail payloads) but must reach ONLY a finance-viewer
   (lib/houzs-perms.canViewScmFinance). Mirrors SO_FINANCE_KEYS — the CO is a
   /mfg-sales-orders clone — minus service_centi / service_cost_centi, which the
   consignment header does not carry. Order money everyone is meant to see
   (local_total_centi / balance_centi / paid_centi / total_revenue_centi) is
   deliberately NOT listed here — the same line #625 (SO) and #632 (DR) drew.

   Consignment got the SCOPE fix (#417 — salesDocOutOfScope on every detail /
   sub-read) but never the FINANCE fix: canViewScmFinance appeared ZERO times in
   this file, so it declared no finance keys at all while HEADER + ITEM selected
   cost and margin for every caller. Same class as the DO/SI detail leak (#600),
   the SO detail leak (#625) and the DR detail leak (#632). */
export const CO_FINANCE_KEYS = [
  'mattress_sofa_centi', 'bedframe_centi', 'accessories_centi', 'others_centi',
  'mattress_sofa_cost_centi', 'bedframe_cost_centi', 'accessories_cost_centi', 'others_cost_centi',
  'total_cost_centi', 'total_margin_centi', 'margin_pct_basis', 'deposit_centi',
] as const;

/* KEPT LOCAL, deliberately — do NOT "converge" CO_FINANCE_KEYS onto
   SO_FINANCE_KEYS. It is the finance-shaped subset of THIS file's HEADER select.
   The CO is a /mfg-sales-orders clone, so it DOES carry deposit_centi (finance-
   only since #574) — but it has no service_centi / service_cost_centi, because
   the consignment order carries no service category. It is therefore the closest
   of the six to the SO's list and still not equal to it; importing the SO's would
   make this gate depend on a vocabulary this document does not speak. The
   per-LINE keys ARE shared: byte-identical across all seven sales documents, so
   they live in lib/finance-keys (SO_ITEM_FINANCE_KEYS) and are imported above. */

/** Strip header + line cost/margin in place for a non-finance caller. */
export function gateCoFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  salesOrder: unknown,
  items: unknown,
): void {
  if (canViewScmFinance(c)) return;
  for (const h of (Array.isArray(salesOrder) ? salesOrder : [salesOrder]) as Array<unknown>) {
    if (h && typeof h === 'object') {
      for (const k of CO_FINANCE_KEYS) delete (h as Record<string, unknown>)[k];
    }
  }
  for (const it of (Array.isArray(items) ? items : items ? [items] : []) as Array<Record<string, unknown>>) {
    for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
  }
}
