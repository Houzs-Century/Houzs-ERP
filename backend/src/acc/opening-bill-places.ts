// ----------------------------------------------------------------------------
// opening-bill-places — where a payment of an opening bill (an AutoCount bill
// brought over at go-live, scm.ap_invoices.opening) reads in the Cash Flow.
// Its own line is the opening clearing, which says nothing of what was bought.
//
// In order (owner 2026-11-25, 「要，做 A」):
//   1. the bill's own choice (scm.acc_opening_bill_places) — for a supplier
//      whose bills are for different things (「根据purpose去放」);
//   2. what the bill bought, read from AutoCount's own lines
//      (scm.acc_opening_bill_goods; 「如果系统可以分得出purchase of sofa 和
//      purchase of bedding 更加好」): its sofa and its bedding (bed frames,
//      mattresses), each on its group's purchase account, in proportion, as a
//      purchase invoice reads; the rest of the bill (other goods, lines with
//      no group) goes on down this list;
//   3. its supplier's choice (scm.acc_opening_supplier_places);
//   4. the supplier's own live bills in the ERP: the one account they sit on,
//      else the one Cash Flow category those accounts print directly under;
//   5. else the creditor control.
// A choice is an account of the company's chart or a Cash Flow category.
// Cash Flow only: nothing here posts.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { MAIN_CATEGORIES } from '../scm/lib/so-readiness';
import { OPENING_CLEARING } from './opening-balance';
import type { CashFlowHome } from './report-layout';
import type { resolveRoles } from './rules';

export type PlaceAccount = { code: string; name: string };
/** Where an opening bill's payment reads: an account, or a Cash Flow category (by id). */
export type OpeningPlace = ({ kind: 'account' } & PlaceAccount) | { kind: 'category'; id: string };
/** A choice as stored: exactly one of the two is set. */
export type StoredPlace = { account: string | null; category: string | null };

type Fail = { ok: false; reason: string };
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

/** What an opening bill bought, by product group (as scm.acc_item_group_accounts names it; '' = no group): MYR sen before tax. */
export type BillGoods = ReadonlyMap<string, number>;
/** A bill's goods as Cash Flow parts: one per purchase account its groups name, and the rest of the bill. Weights only. */
export type GoodsParts = { parts: Array<{ code: string; sen: number }>; restSen: number };

/** The product groups a bill splits by: the sofa and the bedding in it — the main categories (owner
    2026-11-25, 「分得出purchase of sofa 和purchase of bedding」, having put fabric and other goods
    suppliers on bedding himself). Any other group reads as the rest of the bill, where Finance's
    supplier line puts it. */
export const SPLIT_GROUPS: ReadonlySet<string> = MAIN_CATEGORIES;

/** Each split group with a purchase account on that account (groups sharing one, one part), the
    rest — another group, a group with no account, lines with no group — as one remainder. A part
    not above zero drops out, as does a remainder below zero (a discount line spreads over the
    goods). Null when no part has an account: the bill reads as it would without its goods. */
export function goodsParts(goods: BillGoods | undefined, accountOf: ReadonlyMap<string, string>): GoodsParts | null {
  if (!goods) return null;
  const byAccount = new Map<string, number>();
  let rest = 0;
  for (const [group, sen] of goods) {
    const g = group.trim().toUpperCase();
    const code = SPLIT_GROUPS.has(g) ? accountOf.get(g) : undefined;
    if (code) byAccount.set(code, (byAccount.get(code) ?? 0) + sen);
    else rest += sen;
  }
  const parts = [...byAccount].filter(([, sen]) => sen > 0).map(([code, sen]) => ({ code, sen })).sort((a, b) => a.code.localeCompare(b.code));
  return parts.length === 0 ? null : { parts, restSen: Math.max(0, rest) };
}

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

/** What the named opening bills bought (scm.acc_opening_bill_goods), by bill id; a bill not read is absent. */
export async function loadOpeningBillGoods(sb: Sb, companyId: number, billIds: readonly string[] | 'all'): Promise<{ ok: true; byBill: Map<string, Map<string, number>> } | Fail> {
  type Row = { ap_invoice_id: string; group_code: string; myr_sen: number | string };
  const r = billIds === 'all'
    ? await paginateAll<Row>((f, t) => sb.from('acc_opening_bill_goods').select('ap_invoice_id, group_code, myr_sen').eq('company_id', companyId)
      .order('ap_invoice_id').order('group_code').range(f, t))
    : billIds.length === 0 ? { data: [] as Row[], error: null }
      : await chunkIn<Row>([...new Set(billIds)], (batch, f, t) => sb.from('acc_opening_bill_goods').select('ap_invoice_id, group_code, myr_sen')
        .eq('company_id', companyId).in('ap_invoice_id', batch).range(f, t));
  if (r.error) return { ok: false, reason: `opening bill goods: ${failed(r.error)}` };
  const byBill = new Map<string, Map<string, number>>();
  for (const row of r.data ?? []) {
    const id = String(row.ap_invoice_id);
    byBill.set(id, (byBill.get(id) ?? new Map<string, number>()).set(String(row.group_code), Number(row.myr_sen)));
  }
  return { ok: true, byBill };
}

/** The company's purchase account per product group (scm.acc_item_group_accounts), groups upper-case. */
export async function loadGroupPurchaseAccounts(sb: Sb, companyId: number): Promise<{ ok: true; accountOf: Map<string, string> } | Fail> {
  const { data, error } = await sb.from('acc_item_group_accounts').select('group_code, purchase_account').eq('company_id', companyId);
  if (error) return { ok: false, reason: `item group accounts: ${failed(error)}` };
  const accountOf = new Map<string, string>();
  for (const b of (data ?? []) as Array<{ group_code: string | null; purchase_account: string | null }>) {
    const code = String(b.purchase_account ?? '').trim();
    if (code) accountOf.set(String(b.group_code ?? '').trim().toUpperCase(), code);
  }
  return { ok: true, accountOf };
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
