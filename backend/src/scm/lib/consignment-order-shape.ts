import { canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
export const HEADER =
  'doc_no, transfer_to, so_date, branding, debtor_code, debtor_name, agent, sales_location, ref, po_doc_no, venue, venue_id, ' +
  'address1, address2, address3, address4, phone, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, local_total_sen, balance_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, ' +
  'total_cost_sen, total_revenue_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, status, remark2, remark3, remark4, note, sales_exemption_expiry, ' +
  'customer_id, customer_po, customer_po_id, customer_po_date, customer_po_image_b64, customer_so_no, hub_id, hub_name, ' +
  'customer_state, customer_country, customer_delivery_date, processing_date, linked_do_doc_no, ' +
  'ship_to_address, bill_to_address, install_to_address, subtotal_sen, overdue, ' +
  'email, customer_type, salesperson_id, city, postcode, building_type, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, target_date, ' +
  'payment_method, installment_months, merchant_provider, approval_code, payment_date, deposit_sen, paid_sen, ' +
  'created_at, created_by, updated_at';
export const ITEM =
  'id, doc_no, line_date, debtor_code, debtor_name, agent, item_group, item_code, description, description2, ' +
  'uom, location, qty, unit_price_sen, discount_sen, total_sen, tax_sen, total_inc_sen, balance_sen, ' +
  'payment_status, venue, branding, remark, cancelled, variants, unit_cost_sen, line_cost_sen, line_margin_sen, ' +
  'line_delivery_date, line_delivery_date_overridden, ' +
  'photo_urls, ' +
  'created_at';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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

export function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export const CO_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis', 'deposit_sen',
] as const;


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
