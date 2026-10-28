// ----------------------------------------------------------------------------
// SupplierFinanceReminder — the supplier being paid lacks its Finance details
// (owner 2026-09-29, decision 10b: 先付款，只提醒 — the payment is NOT blocked,
// Finance is told what is missing and where to fill it).
//
// What counts: the tax identity a supplier's e-invoice needs — the TIN, and a
// registration number (the new-format registration_no or the older
// business_reg_no, either one). Credit limit, statement type and aging basis
// all have working defaults and are not asked about here.
//
// Read from the supplier DETAIL, and only when the caller can see the Finance
// part at all: the server leaves those keys OUT for a caller who is not
// Finance (suppliers.ts, owner 2026-09-30), and an absent key is "not yours to
// see", never "missing" — so a purchaser is never nagged about fields they
// cannot fill.
// ----------------------------------------------------------------------------

import { Link } from 'react-router-dom';
import { useSupplierDetail, type SupplierRow } from '../lib/suppliers-queries';
import { supplierBankLine } from '../lib/supplier-maintenance-queries';

/** Where Finance fills a supplier's Finance part: its pop-out in Supplier
    Maintenance (owner 2026-10-02). */
export const supplierMaintenanceHref = (id: string): string => `/scm/supplier-maintenance?open=${encodeURIComponent(id)}`;

type FinanceIdentity = Partial<Pick<SupplierRow, 'tin_number' | 'business_reg_no' | 'registration_no'>>;

/** What is missing, or null when this caller cannot see the Finance part. */
export function missingSupplierFinance(s: FinanceIdentity | null | undefined): string[] | null {
  if (!s) return null;
  if (!('tin_number' in s) && !('business_reg_no' in s) && !('registration_no' in s)) return null;
  const blank = (v: string | null | undefined) => !String(v ?? '').trim();
  const missing: string[] = [];
  if (blank(s.tin_number)) missing.push('TIN');
  if (blank(s.registration_no) && blank(s.business_reg_no)) missing.push('registration no.');
  return missing;
}

export function SupplierFinanceReminder({ supplierId }: { supplierId: string | null | undefined }) {
  const q = useSupplierDetail(supplierId || null);
  const s = q.data?.supplier;
  const missing = missingSupplierFinance(s);
  if (!s || !missing || missing.length === 0) return null;
  return (
    <div role="status" aria-label="Supplier finance details missing"
      style={{ fontSize: 'var(--fs-12)', color: '#8a5a12', background: '#fdf2df', borderRadius: 8, padding: '6px 10px' }}>
      {s.name} has no {missing.join(' or ')} in its Finance details — the payment can still go ahead; fill {missing.length > 1 ? 'them' : 'it'} in on
      {' '}<Link to={supplierMaintenanceHref(s.id)} style={{ color: 'inherit', textDecoration: 'underline' }}>Supplier Maintenance</Link> (the e-invoice will need {missing.length > 1 ? 'them' : 'it'}).
    </div>
  );
}

/**
 * The supplier's bank — where the payment goes (owner 2026-10-02, A3a:
 * 加上银行资料，付款时自动带出来). Shown only to a caller who sees the Finance
 * part (the server leaves the bank out for anyone else); a supplier with no bank
 * kept says where to add it.
 */
export function SupplierPayTo({ supplierId }: { supplierId: string | null | undefined }) {
  const q = useSupplierDetail(supplierId || null);
  const s = q.data?.supplier;
  if (!s || !('bank_name' in s || 'bank_account_no' in s || 'bank_account_name' in s)) return null;
  const line = supplierBankLine(s);
  return (
    <div aria-label="Supplier bank" style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
      {line
        ? <>Pay to: <span style={{ color: 'var(--c-ink)', fontWeight: 600 }}>{line}</span></>
        : <>No bank kept for {s.name} — add it in <Link to={supplierMaintenanceHref(s.id)} style={{ color: 'inherit', textDecoration: 'underline' }}>Supplier Maintenance</Link>.</>}
    </div>
  );
}
