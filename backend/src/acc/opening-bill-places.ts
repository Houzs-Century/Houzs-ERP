// ----------------------------------------------------------------------------
// opening-bill-places — where a payment of an opening bill (an AutoCount bill
// brought over at go-live, scm.ap_invoices.opening) reads in the Cash Flow.
// Its own line is the opening clearing, which says nothing of what was bought.
//
// In order (owner 2026-11-25, 「要，做 A」):
//   1. the bill's own choice (scm.acc_opening_bill_places) — for a supplier
//      whose bills are for different things (「根据purpose去放」);
//   2. its supplier's choice (scm.acc_opening_supplier_places);
//   3. the supplier's own live bills in the ERP: the one account they sit on,
//      else the one Cash Flow category those accounts print directly under;
//   4. else the creditor control.
// A choice is an account of the company's chart or a Cash Flow category.
// Cash Flow only: nothing here posts.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { OPENING_CLEARING } from './opening-balance';
import type { CashFlowHome } from './report-layout';
import type { resolveRoles } from './rules';

export type PlaceAccount = { code: string; name: string };
/** Where an opening bill's payment reads: an account, or a Cash Flow category (by id). */
export type OpeningPlace = ({ kind: 'account' } & PlaceAccount) | { kind: 'category'; id: string };
/** A choice as stored: exactly one of the two is set. */
export type StoredPlace = { account: string | null; category: string | null };

type Fail = { ok: false; reason: string };
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);

/** An AP invoice that is a real bill: neither a draft nor cancelled — what the settle function takes. */
export const LIVE_BILL_NOT = '(DRAFT,CANCELLED)';

/** Where the supplier's own bills in the ERP put it: the one account they sit on; else the one
    Cash Flow category every one of those accounts prints directly under (`homes`, the payment's
    direction); else — spread over categories, one not placed, or no bill in the ERP — null. */
export function openingBillHome(accounts: readonly PlaceAccount[], homes: ReadonlyMap<string, CashFlowHome>): ({ kind: 'account' } & PlaceAccount) | ({ kind: 'category' } & CashFlowHome) | null {
  if (accounts.length === 0) return null;
  const [first, ...rest] = accounts;
  if (rest.length === 0) return { kind: 'account', ...first };
  const home = homes.get(first.code);
  if (!home || rest.some((a) => homes.get(a.code)?.id !== home.id)) return null;
  return { kind: 'category', ...home };
}

/** Finance's choice for one bill: its own, else its supplier's, else none. */
export const chosenPlace = (bill: StoredPlace | undefined, supplier: StoredPlace | undefined): StoredPlace | null => bill ?? supplier ?? null;

/** A stored choice as a place, the account named. */
export const placeOf = (p: StoredPlace, nameOf: (code: string) => string): OpeningPlace =>
  p.account ? { kind: 'account', code: p.account, name: nameOf(p.account) } : { kind: 'category', id: String(p.category) };

/** The account codes each supplier's own live bills in the ERP sit on (not opening, not draft,
    not cancelled), sorted; the opening clearing never counts. A supplier with none is absent. */
export async function loadSupplierBillAccounts(sb: Sb, companyId: number, supplierIds: readonly string[]): Promise<{ ok: true; bySupplier: Map<string, string[]> } | Fail> {
  const bySupplier = new Map<string, string[]>();
  if (supplierIds.length === 0) return { ok: true, bySupplier };
  const bills = await chunkIn<{ id: string; supplier_id: string }>([...new Set(supplierIds)], (batch, f, t) => sb.from('ap_invoices')
    .select('id, supplier_id').eq('company_id', companyId).in('supplier_id', batch).eq('opening', false)
    .not('status', 'in', LIVE_BILL_NOT).range(f, t));
  if (bills.error) return { ok: false, reason: bills.error.message };
  const supplierOf = new Map(bills.data.map((b) => [String(b.id), String(b.supplier_id)]));
  const lines = await chunkIn<{ invoice_id: string; debit_account_code: string }>([...supplierOf.keys()], (batch, f, t) => sb.from('ap_invoice_lines')
    .select('invoice_id, debit_account_code').eq('company_id', companyId).in('invoice_id', batch).range(f, t));
  if (lines.error) return { ok: false, reason: lines.error.message };
  const codes = new Map<string, Set<string>>();
  for (const l of lines.data) {
    const supplier = supplierOf.get(String(l.invoice_id));
    const code = String(l.debit_account_code);
    if (supplier && code !== OPENING_CLEARING) codes.set(supplier, (codes.get(supplier) ?? new Set<string>()).add(code));
  }
  for (const [supplier, set] of codes) bySupplier.set(supplier, [...set].sort());
  return { ok: true, bySupplier };
}

/** Finance's choices of the company, by supplier id and by bill id (both tables are small: read whole). */
export async function loadOpeningPlaces(sb: Sb, companyId: number): Promise<{ ok: true; suppliers: Map<string, StoredPlace>; bills: Map<string, StoredPlace> } | Fail> {
  type Row = { supplier_id?: string; ap_invoice_id?: string; account_code: string | null; category_id: string | null };
  const [sup, bill] = await Promise.all([
    paginateAll<Row>((f, t) => sb.from('acc_opening_supplier_places').select('supplier_id, account_code, category_id').eq('company_id', companyId).order('supplier_id').range(f, t)),
    paginateAll<Row>((f, t) => sb.from('acc_opening_bill_places').select('ap_invoice_id, account_code, category_id').eq('company_id', companyId).order('ap_invoice_id').range(f, t)),
  ]);
  if (sup.error) return { ok: false, reason: `opening bill places: ${failed(sup.error)}` };
  if (bill.error) return { ok: false, reason: `opening bill places: ${failed(bill.error)}` };
  const stored = (r: Row): StoredPlace => ({ account: r.account_code ?? null, category: r.account_code ? null : (r.category_id ?? null) });
  return {
    ok: true,
    suppliers: new Map((sup.data ?? []).map((r) => [String(r.supplier_id), stored(r)])),
    bills: new Map((bill.data ?? []).map((r) => [String(r.ap_invoice_id), stored(r)])),
  };
}
