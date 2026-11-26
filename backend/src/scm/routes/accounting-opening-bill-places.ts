// ----------------------------------------------------------------------------
// accounting-opening-bill-places — Finance's choice of where payments of the
// opening bills (the AutoCount bills brought over at go-live) read in the Cash
// Flow (owner 2026-11-25, 「要，做 A」): per supplier, and per bill where one
// supplier's bills are for different things (「根据purpose去放」). The order and
// the automatic rule: acc/opening-bill-places.ts. Cash Flow only: nothing posts.
//
//   GET /accounting/reports/receipts-payments/opening-bills
//       each supplier with opening bills: how many, what is still owed, its
//       choice, what its own ERP bills give; the pick lists (the company's
//       accounts, the Cash Flow's categories).
//   GET /accounting/reports/receipts-payments/opening-bills/:supplierId
//       that supplier's opening bills, each with its own choice and what it
//       bought by AutoCount's lines (scm.acc_opening_bill_goods), as the Cash
//       Flow splits it.
//   PUT /accounting/reports/receipts-payments/opening-bills/place
//       { supplierId, billId, account, category }: one of supplierId / billId;
//       an account or a category, or neither to clear the choice.
// Read and write = scm.payment_voucher.post, as arranging the Cash Flow.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { cashFlowHomes, type LayoutItem } from '../../acc/report-layout';
import {
  goodsParts, loadGroupPurchaseAccounts, loadOpeningBillGoods, loadOpeningPlaces, loadSupplierBillAccounts, openingBillHome,
  type PlaceAccount, type StoredPlace,
} from '../../acc/opening-bill-places';
import { allowedIds, resolveLayout } from './accounting-report-layouts';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
const PERM = 'scm.payment_voucher.post';
const NO_PERM = { error: "You don't have permission to arrange the financial statements." };
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);
const who = (c: Ctx): string => String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? '');
const OPEN = new Set(['POSTED', 'PARTIALLY_PAID']);

/** A choice or the rule's answer as the page shows it. */
export type PlaceOut = ({ kind: 'account' } & PlaceAccount) | { kind: 'category'; id: string; label: string };
export type CashFlowCategory = { id: string; label: string; path: string };
export type OpeningSupplierRow = {
  id: string; code: string; name: string;
  bills: number; openBills: number; owingSen: number; paidSen: number;
  billsSet: number;
  billsByGoods: number;
  set: PlaceOut | null;
  auto: PlaceOut | null;
};
export type OpeningBillsPayload = { suppliers: OpeningSupplierRow[]; accounts: PlaceAccount[]; categories: CashFlowCategory[] };
/** What a bill bought as the Cash Flow splits it: a share per purchase account, and the rest that reads as the supplier's line. Weights only. */
export type BillGoodsOut = { parts: Array<PlaceAccount & { sen: number }>; restSen: number };
export type OpeningBillRow = {
  id: string; number: string; date: string; text: string; totalSen: number; paidSen: number; status: string; set: PlaceOut | null;
  goods: BillGoodsOut | null;
};

type Sb = Parameters<typeof loadOpeningPlaces>[0];

/** The Cash Flow's categories this company prints (an unticked one and all under it left out), with their path. */
export function cashFlowCategories(items: LayoutItem[], companyId: number): CashFlowCategory[] {
  const out: CashFlowCategory[] = [];
  const walk = (list: LayoutItem[], trail: string[]): void => {
    for (const it of list) {
      if (it.kind !== 'category' || it.hiddenFor?.includes(companyId)) continue;
      const path = [...trail, it.label];
      out.push({ id: it.id, label: it.label, path: path.join(' › ') });
      walk(it.children, path);
    }
  };
  walk(items, []);
  return out;
}

/** The text an opening bill carries, without the import's own prefix. */
export const billText = (notes: string | null): string => String(notes ?? '').replace(/^OPENING \d{2}\/\d{2} FROM AUTOCOUNT:\s*/i, '').trim();

async function loadTree(c: Ctx, sb: Sb): Promise<{ ok: true; items: LayoutItem[] } | { ok: false; reason: string }> {
  const laid = await resolveLayout(sb, allowedIds(c), 'rp');
  if (!laid.ok) return laid;
  return { ok: true, items: laid.layout.blocks.accounts };
}

async function loadAccounts(sb: Sb, companyId: number): Promise<{ ok: true; accounts: PlaceAccount[]; all: Map<string, string> } | { ok: false; reason: string }> {
  type Row = { account_code: string; account_name: string | null; acc_money: boolean | null; is_active: boolean | null };
  const r = await paginateAll<Row>((f, t) => sb.from('accounts').select('account_code, account_name, acc_money, is_active')
    .eq('company_id', companyId).order('account_code').range(f, t));
  if (r.error) return { ok: false, reason: `accounts: ${failed(r.error)}` };
  const rows = r.data ?? [];
  return {
    ok: true,
    accounts: rows.filter((a) => a.is_active === true && a.acc_money !== true).map((a) => ({ code: String(a.account_code), name: String(a.account_name ?? a.account_code) })),
    all: new Map(rows.map((a) => [String(a.account_code), String(a.account_name ?? a.account_code)])),
  };
}

const outOf = (p: StoredPlace | undefined, names: Map<string, string>, labels: Map<string, string>): PlaceOut | null => {
  if (!p) return null;
  if (p.account) return { kind: 'account', code: p.account, name: names.get(p.account) ?? p.account };
  const id = String(p.category);
  return { kind: 'category', id, label: labels.get(id) ?? `${id} (not on the Cash Flow)` };
};

export const openingBillsGet = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase') as Sb;
  type Bill = { id: string; supplier_id: string; status: string | null; total_sen: number | null; paid_sen: number | null };
  const [bills, places, tree, accs, goods, groups] = await Promise.all([
    paginateAll<Bill>((f, t) => sb.from('ap_invoices').select('id, supplier_id, status, total_sen, paid_sen')
      .eq('company_id', co.companyId).eq('opening', true).order('id').range(f, t)),
    loadOpeningPlaces(sb, co.companyId), loadTree(c, sb), loadAccounts(sb, co.companyId),
    loadOpeningBillGoods(sb, co.companyId, 'all'), loadGroupPurchaseAccounts(sb, co.companyId),
  ]);
  if (bills.error) return c.json({ error: 'load_failed', reason: `opening bills: ${failed(bills.error)}` }, 500);
  if (!places.ok) return c.json({ error: 'load_failed', reason: places.reason }, 500);
  if (!tree.ok) return c.json({ error: 'load_failed', reason: tree.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!goods.ok) return c.json({ error: 'load_failed', reason: goods.reason }, 500);
  if (!groups.ok) return c.json({ error: 'load_failed', reason: groups.reason }, 500);

  const per = new Map<string, { bills: number; openBills: number; owingSen: number; paidSen: number; billsSet: number; billsByGoods: number }>();
  for (const b of bills.data ?? []) {
    const s = per.get(String(b.supplier_id)) ?? { bills: 0, openBills: 0, owingSen: 0, paidSen: 0, billsSet: 0, billsByGoods: 0 };
    s.bills += 1;
    s.paidSen += Number(b.paid_sen ?? 0);
    if (OPEN.has(String(b.status ?? '').toUpperCase())) {
      s.openBills += 1;
      s.owingSen += Math.max(0, Number(b.total_sen ?? 0) - Number(b.paid_sen ?? 0));
    }
    if (places.bills.has(String(b.id))) s.billsSet += 1;
    else if (goodsParts(goods.byBill.get(String(b.id)), groups.accountOf)) s.billsByGoods += 1;
    per.set(String(b.supplier_id), s);
  }
  const ids = [...per.keys()];
  const [sups, own] = await Promise.all([
    chunkIn<{ id: string; code: string | null; name: string | null }>(ids, (batch, f, t) => sb.from('suppliers').select('id, code, name')
      .eq('company_id', co.companyId).in('id', batch).range(f, t)),
    loadSupplierBillAccounts(sb, co.companyId, ids),
  ]);
  if (sups.error) return c.json({ error: 'load_failed', reason: `suppliers: ${sups.error.message}` }, 500);
  if (!own.ok) return c.json({ error: 'load_failed', reason: own.reason }, 500);

  const categories = cashFlowCategories(tree.items, co.companyId);
  const labels = new Map(categories.map((k) => [k.id, k.label]));
  const homes = cashFlowHomes(tree.items, co.companyId).out;
  const named = new Map(sups.data.map((s) => [String(s.id), s]));
  const suppliers: OpeningSupplierRow[] = ids.map((id) => {
    const s = named.get(id);
    const auto = openingBillHome((own.bySupplier.get(id) ?? []).map((code) => ({ code, name: accs.all.get(code) ?? code })), homes);
    return {
      id, code: String(s?.code ?? ''), name: String(s?.name ?? s?.code ?? id), ...per.get(id)!,
      set: outOf(places.suppliers.get(id), accs.all, labels),
      auto: auto === null ? null : auto.kind === 'account' ? auto : { kind: 'category' as const, id: auto.id, label: auto.label },
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const payload: OpeningBillsPayload = { suppliers, accounts: accs.accounts, categories };
  return c.json(payload);
};

export const openingBillsOfSupplier = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase') as Sb;
  const supplierId = String(c.req.param('supplierId') ?? '').trim();
  type Bill = { id: string; invoice_number: string; invoice_date: string; status: string | null; total_sen: number | null; paid_sen: number | null; notes: string | null };
  const [bills, places, tree, accs, groups] = await Promise.all([
    paginateAll<Bill>((f, t) => sb.from('ap_invoices').select('id, invoice_number, invoice_date, status, total_sen, paid_sen, notes')
      .eq('company_id', co.companyId).eq('supplier_id', supplierId).eq('opening', true).order('invoice_date').order('invoice_number').range(f, t)),
    loadOpeningPlaces(sb, co.companyId), loadTree(c, sb), loadAccounts(sb, co.companyId), loadGroupPurchaseAccounts(sb, co.companyId),
  ]);
  if (bills.error) return c.json({ error: 'load_failed', reason: `opening bills: ${failed(bills.error)}` }, 500);
  if (!places.ok) return c.json({ error: 'load_failed', reason: places.reason }, 500);
  if (!tree.ok) return c.json({ error: 'load_failed', reason: tree.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!groups.ok) return c.json({ error: 'load_failed', reason: groups.reason }, 500);
  if ((bills.data ?? []).length === 0) return c.json({ error: 'not_found', message: 'This company has no opening bill from that supplier.' }, 404);
  const goods = await loadOpeningBillGoods(sb, co.companyId, (bills.data ?? []).map((b) => String(b.id)));
  if (!goods.ok) return c.json({ error: 'load_failed', reason: goods.reason }, 500);
  const labels = new Map(cashFlowCategories(tree.items, co.companyId).map((k) => [k.id, k.label]));
  const rows: OpeningBillRow[] = (bills.data ?? []).map((b) => {
    const g = goodsParts(goods.byBill.get(String(b.id)), groups.accountOf);
    return {
      id: String(b.id), number: String(b.invoice_number), date: String(b.invoice_date), text: billText(b.notes),
      totalSen: Number(b.total_sen ?? 0), paidSen: Number(b.paid_sen ?? 0), status: String(b.status ?? ''),
      set: outOf(places.bills.get(String(b.id)), accs.all, labels),
      goods: g === null ? null : { parts: g.parts.map((p) => ({ code: p.code, name: accs.all.get(p.code) ?? p.code, sen: p.sen })), restSen: g.restSen },
    };
  });
  return c.json({ bills: rows });
};

/** The body as sent, or the first thing wrong with it. */
export function readPlaceBody(raw: unknown): { ok: true; supplierId: string | null; billId: string | null; place: StoredPlace | null } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'Send { supplierId, billId, account, category }.' };
  const o = raw as Record<string, unknown>;
  const text = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const supplierId = text(o.supplierId);
  const billId = text(o.billId);
  const account = text(o.account);
  const category = text(o.category);
  if (supplierId === undefined || billId === undefined || account === undefined || category === undefined) {
    return { ok: false, message: 'supplierId, billId, account and category are each text or null.' };
  }
  if ((supplierId === null) === (billId === null)) return { ok: false, message: 'Name one supplier or one bill.' };
  if (account !== null && category !== null) return { ok: false, message: 'Choose an account or a category, not both.' };
  return { ok: true, supplierId, billId, place: account === null && category === null ? null : { account, category } };
}

export const openingBillPlacePut = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase') as Sb;
  let raw: unknown = null;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const body = readPlaceBody(raw);
  if (!body.ok) return c.json({ error: 'bad_place', message: body.message }, 400);

  const target = body.supplierId
    ? await sb.from('ap_invoices').select('id').eq('company_id', co.companyId).eq('supplier_id', body.supplierId).eq('opening', true).limit(1)
    : await sb.from('ap_invoices').select('id').eq('company_id', co.companyId).eq('id', body.billId).eq('opening', true).limit(1);
  if (target.error) return c.json({ error: 'load_failed', reason: failed(target.error) }, 500);
  if ((target.data ?? []).length === 0) return c.json({ error: 'not_found', message: body.supplierId ? 'This company has no opening bill from that supplier.' : 'That is not an opening bill of this company.' }, 404);

  if (body.place?.account) {
    const a = await sb.from('accounts').select('account_code, acc_money, is_active').eq('company_id', co.companyId).eq('account_code', body.place.account).maybeSingle();
    if (a.error) return c.json({ error: 'load_failed', reason: failed(a.error) }, 500);
    const acct = a.data as { acc_money: boolean | null; is_active: boolean | null } | null;
    if (!acct || acct.is_active !== true) return c.json({ error: 'bad_account', message: `${body.place.account} is not an active account of this company.` }, 400);
    if (acct.acc_money === true) return c.json({ error: 'bad_account', message: `${body.place.account} is a bank or cash account; a payment cannot read as one.` }, 400);
  }
  if (body.place?.category) {
    const tree = await loadTree(c, sb);
    if (!tree.ok) return c.json({ error: 'load_failed', reason: tree.reason }, 500);
    if (!cashFlowCategories(tree.items, co.companyId).some((k) => k.id === body.place!.category)) {
      return c.json({ error: 'bad_category', message: 'That category is not on this company\'s Cash Flow.' }, 400);
    }
  }

  const stamp = { updated_at: new Date().toISOString(), updated_by: who(c) };
  const saved = body.supplierId
    ? body.place === null
      ? await sb.from('acc_opening_supplier_places').delete().eq('company_id', co.companyId).eq('supplier_id', body.supplierId)
      : await sb.from('acc_opening_supplier_places').upsert(
        { company_id: co.companyId, supplier_id: body.supplierId, account_code: body.place.account, category_id: body.place.category, ...stamp },
        { onConflict: 'company_id,supplier_id' })
    : body.place === null
      ? await sb.from('acc_opening_bill_places').delete().eq('company_id', co.companyId).eq('ap_invoice_id', body.billId)
      : await sb.from('acc_opening_bill_places').upsert(
        { company_id: co.companyId, ap_invoice_id: body.billId, account_code: body.place.account, category_id: body.place.category, ...stamp },
        { onConflict: 'company_id,ap_invoice_id' });
  if (saved.error) return c.json({ error: 'save_failed', reason: failed(saved.error) }, 500);
  return c.json({ ok: true });
};
