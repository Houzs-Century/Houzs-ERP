// ----------------------------------------------------------------------------
// accounting-forecast — the Forecast P&L's doors (owner 2026-09-21: 我也需要这
// 个功能 — the Hookka Forecast P&L, trading edition; 做).
//
//   GET /accounting/forecast                       the grid, its supplier figures, the P&L accounts a
//                                                  line may name (active leaves, sectioned as the
//                                                  statement sections them, the purchase accounts
//                                                  marked), the P&L layout tree the page lays the
//                                                  rows on, and the company's suppliers (each with
//                                                  the purchase accounts it billed lately)
//   PUT /accounting/forecast  { months, suppliers } the WHOLE grid: validated cell by cell (the
//                                                  first bad cell is named, nothing is kept), months
//                                                  absent from the body are removed; a body without
//                                                  `suppliers` keeps each kept month's supplier figures
//   GET /accounting/forecast/figures?from&to       each month's figures — the Dashboard's forecast
//                                                  side, the same arithmetic the page shows
//
// scm.acc_forecast_pnl is a planning table, one row per month per company;
// nothing here posts. The rules — one of amount / percent, a sales line an
// amount, a purchase line split by supplier is their sum, the blocks' totals —
// live in scm/shared/forecast-pnl.ts, vendored byte-identical to the page.
// Reading takes the statements' key, writing the vouchers' write key. Every
// read and write carries the active company's predicate — the accounts, the
// bindings, the grid, the suppliers and the ledger alike.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { defaultSectionFor } from '../lib/account-sections';
import { paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import {
  FORECAST_MONTH_RE, blockOfSection, isPurchaseAccount, isPurchaseOfChart, isSalesAccount, monthFigures, sortedMonths, validateGrid, validateSuppliers,
  type ForecastAccount, type ForecastGrid, type ForecastLines, type SupplierGrid, type SupplierLines,
} from '../shared/forecast-pnl';

type Ctx = any;
/** The supabase-js client the SCM routes are handed (c.get('supabase')). */
type Sb = any;
type Row = Record<string, unknown>;

const READ_PERM = 'scm.payment_voucher.post';
const WRITE_PERM = 'scm.payment_voucher.write';
const NO_READ = { error: "You don't have permission to read the forecast." };
const NO_WRITE = { error: "You don't have permission to change the forecast." };
const who = (c: Ctx): string => String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? '');

/** The P&L's own accounts a forecast line may name: active leaves of the five
    blocks, sectioned as the statement sections them (the stored section, else
    the default shelf for the type — the P&L's own rule). A PURCHASE account
    carries its `basis`: the sales accounts of the item groups bound to it
    (scm.acc_item_group_accounts — bedding's two groups both name 601-0001 →
    500-0001), so its percentage is of its own group's sales, not the month's
    whole (owner 2026-09-29). A bound sales account that is not itself a
    forecast line (inactive, a header) is left out; a binding with none left
    stamps nothing and the line stays on the whole sales. A purchase account
    (isPurchaseOfChart: bound to an item group as its purchase account, or
    named a purchase under Cost of Goods Sold) carries `purchase: true` — its
    month may be split by supplier. */
export async function loadForecastAccounts(sb: Sb, companyId: number): Promise<{ ok: true; accounts: ForecastAccount[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('accounts')
    .select('account_code, account_name, account_type, parent_code, section, is_active')
    .eq('company_id', companyId);
  if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  const rows = (data ?? []) as Array<{ account_code: string; account_name: string | null; account_type: string; parent_code: string | null; section: string | null; is_active: boolean | null }>;
  const parents = new Set(rows.map((r) => r.parent_code).filter((p): p is string => p != null && p !== ''));
  const accounts = rows
    .filter((r) => r.is_active !== false && !parents.has(r.account_code))
    .map((r) => ({
      code: r.account_code,
      name: r.account_name ?? r.account_code,
      type: r.account_type,
      section: r.section ?? defaultSectionFor(r.account_type, r.account_code),
    }))
    .filter((a) => blockOfSection(a.section) !== null)
    .sort((a, b) => a.code.localeCompare(b.code));
  const { data: bound, error: bErr } = await sb.from('acc_item_group_accounts')
    .select('group_code, sales_account, purchase_account')
    .eq('company_id', companyId);
  if (bErr) return { ok: false, reason: String((bErr as { message?: string }).message ?? bErr) };
  const salesCodes = new Set(accounts.filter(isSalesAccount).map((a) => a.code));
  const basisOf = new Map<string, Set<string>>();
  const boundPurchase = new Set<string>();
  for (const b of (bound ?? []) as Array<{ sales_account: string | null; purchase_account: string | null }>) {
    const purchase = String(b.purchase_account ?? '').trim();
    const sales = String(b.sales_account ?? '').trim();
    if (purchase) boundPurchase.add(purchase);
    if (!purchase || !sales || !salesCodes.has(sales)) continue;
    const set = basisOf.get(purchase) ?? new Set<string>();
    set.add(sales);
    basisOf.set(purchase, set);
  }
  return {
    ok: true,
    accounts: accounts.map((a) => {
      const set = basisOf.get(a.code);
      const withBasis: ForecastAccount = set && set.size > 0 && !isSalesAccount(a) ? { ...a, basis: [...set].sort() } : a;
      return isPurchaseOfChart(a, boundPurchase.has(a.code)) ? { ...withBasis, purchase: true } : withBasis;
    }),
  };
}

export type StoredForecast = { ok: true; grid: ForecastGrid; suppliers: SupplierGrid } | { ok: false; reason: string };

/** The company's forecast as stored: each month's lines, and its supplier
    figures where it has any (a month with none is absent from `suppliers`). */
export async function loadGrid(sb: Sb, companyId: number): Promise<StoredForecast> {
  const { data, error } = await sb.from('acc_forecast_pnl').select('month, lines, suppliers').eq('company_id', companyId);
  if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  const grid: ForecastGrid = {};
  const suppliers: SupplierGrid = {};
  for (const r of (data ?? []) as Array<{ month: string; lines: ForecastLines | null; suppliers: SupplierLines | null }>) {
    const month = String(r.month);
    grid[month] = (r.lines ?? {}) as ForecastLines;
    if (r.suppliers && Object.keys(r.suppliers).length > 0) suppliers[month] = r.suppliers;
  }
  return { ok: true, grid, suppliers };
}

/* ── The suppliers a purchase line lists ─────────────────────────────────── */

/** A supplier of the company as the page offers it: `recent` — the purchase
    accounts its bills (purchase invoices, AP invoices) landed on lately. */
export type ForecastSupplier = { id: string; code: string; name: string; active: boolean; recent: string[] };

/** "Lately": from the first day of the month three months before this one
    (the window the Hookka page lists a material's suppliers from) — on
    2026-11-24, from 2026-08-01. */
export function recentFrom(today: string): string {
  const [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
  const back = y * 12 + (m - 1) - 3;
  return `${Math.floor(back / 12)}-${String((back % 12) + 1).padStart(2, '0')}-01`;
}

export type SupplierBillLine = {
  je_no: string; account_code: string; debit_sen: number | null; credit_sen: number | null;
  party_type: string | null; party_code: string | null;
  posted: boolean | null; reversed?: boolean | null; reversed_by_je?: string | null;
};

/** What each supplier billed each purchase account: the bills' ledger lines
    (one journal per bill, its supplier on the AP line), debit less credit on
    the purchase accounts, summed per supplier and account; a reversed bill and
    its contra count nowhere (the books' own rule), and what nets to nothing or
    less is not a purchase. supplier code → account code → sen. */
export function netBilledBySupplier(rows: SupplierBillLine[], purchaseCodes: ReadonlySet<string>): Map<string, Map<string, number>> {
  const counted = rows.filter((r) => countsInTheBooks(r));
  const supplierOf = new Map<string, string>();
  for (const r of counted) if (r.party_type === 'SUPPLIER' && r.party_code) supplierOf.set(r.je_no, r.party_code);
  const net = new Map<string, Map<string, number>>();
  for (const r of counted) {
    const supplier = supplierOf.get(r.je_no);
    if (!supplier || !purchaseCodes.has(r.account_code)) continue;
    const by = net.get(supplier) ?? new Map<string, number>();
    by.set(r.account_code, (by.get(r.account_code) ?? 0) + Number(r.debit_sen ?? 0) - Number(r.credit_sen ?? 0));
    net.set(supplier, by);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [supplier, by] of net) {
    const kept = new Map([...by].filter(([, sen]) => sen > 0));
    if (kept.size > 0) out.set(supplier, kept);
  }
  return out;
}

/** Which purchase accounts each supplier billed (netBilledBySupplier's accounts). supplier code → account codes. */
export function billedAccountsBySupplier(rows: SupplierBillLine[], purchaseCodes: ReadonlySet<string>): Map<string, Set<string>> {
  return new Map([...netBilledBySupplier(rows, purchaseCodes)].map(([supplier, by]) => [supplier, new Set(by.keys())]));
}

export type SupplierMasterRow = { id: string; code: string; name: string | null; status: string | null; payment_terms: string | null };
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);

/** The active company's suppliers, any status (a keyed one must keep its name), with their payment terms. */
export async function loadSupplierMaster(sb: Sb, companyId: number): Promise<{ ok: true; rows: SupplierMasterRow[] } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('suppliers').select('id, code, name, status, payment_terms').eq('company_id', companyId);
  if (error) return { ok: false, reason: `suppliers: ${failed(error)}` };
  return { ok: true, rows: (data ?? []) as SupplierMasterRow[] };
}

/** The active company's supplier bills dated from `from` (and up to `to`, when one is named), as ledger lines. */
export async function loadSupplierBills(sb: Sb, companyId: number, from: string, to: string | null): Promise<{ ok: true; rows: SupplierBillLine[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll<SupplierBillLine>((f: number, t: number) => {
    const q = sb.from('v_gl_entries')
      .select('je_no, account_code, debit_sen, credit_sen, party_type, party_code, posted, reversed, reversed_by_je')
      .eq('company_id', companyId)
      .in('source_type', ['PI', 'API'])
      .gte('entry_date', from);
    return (to ? q.lte('entry_date', to) : q).order('line_id').range(f, t);
  });
  if (error) return { ok: false, reason: `supplier bills: ${failed(error)}` };
  return { ok: true, rows: (data ?? []) as SupplierBillLine[] };
}

/** The suppliers as the page offers them, by name: each with the purchase accounts it billed lately. */
export function forecastSuppliersOf(master: SupplierMasterRow[], bills: SupplierBillLine[], accounts: ForecastAccount[]): ForecastSupplier[] {
  const billed = billedAccountsBySupplier(bills, new Set(accounts.filter(isPurchaseAccount).map((a) => a.code)));
  return master
    .map((s) => ({
      id: String(s.id),
      code: String(s.code),
      name: String(s.name ?? s.code),
      active: s.status === 'ACTIVE',
      recent: [...(billed.get(String(s.code)) ?? [])].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.code.localeCompare(b.code));
}

export const forecastGetHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_READ, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const [accs, grid, laid, master, bills] = await Promise.all([
    loadForecastAccounts(sb, co.companyId),
    loadGrid(sb, co.companyId),
    resolveLayout(sb, allowedIds(c), 'pnl'),
    loadSupplierMaster(sb, co.companyId),
    loadSupplierBills(sb, co.companyId, recentFrom(todayMyt()), null),
  ]);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!grid.ok) return c.json({ error: 'load_failed', reason: grid.reason }, 500);
  if (!laid.ok) return c.json({ error: 'load_failed', reason: laid.reason }, 500);
  if (!master.ok) return c.json({ error: 'load_failed', reason: master.reason }, 500);
  if (!bills.ok) return c.json({ error: 'load_failed', reason: bills.reason }, 500);
  return c.json({
    months: grid.grid,
    suppliers: grid.suppliers,
    accounts: accs.accounts,
    layout: { stored: laid.stored, blocks: laid.layout.blocks },
    supplierList: forecastSuppliersOf(master.rows, bills.rows, accs.accounts),
  });
};

export const forecastPutHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, WRITE_PERM)) return c.json(NO_WRITE, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const body = (raw !== null && typeof raw === 'object' ? raw : {}) as { months?: unknown; suppliers?: unknown };
  const sb = c.get('supabase');
  const accs = await loadForecastAccounts(sb, co.companyId);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  const checked = validateGrid(body.months, accs.accounts);
  if (!checked.ok) return c.json({ error: 'bad_cell', cell: checked.cell, message: `${checked.cell}: ${checked.reason}` }, 400);
  /* A page that predates the supplier split sends no `suppliers`: each kept
     month keeps its supplier figures (the upsert below leaves the column
     alone) rather than losing them to a tab opened before the deploy. */
  const sendsSuppliers = body.suppliers !== undefined;
  let suppliers: SupplierGrid | null = null;
  if (sendsSuppliers) {
    const master = await loadSupplierMaster(sb, co.companyId);
    if (!master.ok) return c.json({ error: 'load_failed', reason: master.reason }, 500);
    const sup = validateSuppliers(body.suppliers, checked.grid, accs.accounts, new Set(master.rows.map((s) => String(s.id))));
    if (!sup.ok) return c.json({ error: 'bad_cell', cell: sup.cell, message: `${sup.cell}: ${sup.reason}` }, 400);
    suppliers = sup.suppliers;
  }
  const current = await loadGrid(sb, co.companyId);
  if (!current.ok) return c.json({ error: 'load_failed', reason: current.reason }, 500);
  const months = sortedMonths(checked.grid);
  const removed = Object.keys(current.grid).filter((m) => !(m in checked.grid)).sort();
  if (removed.length > 0) {
    const { error } = await sb.from('acc_forecast_pnl').delete().eq('company_id', co.companyId).in('month', removed);
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  if (months.length > 0) {
    const at = new Date().toISOString();
    const rows: Row[] = months.map((m) => ({
      company_id: co.companyId, month: m, lines: checked.grid[m],
      ...(suppliers ? { suppliers: suppliers[m] ?? {} } : {}),
      updated_at: at, updated_by: who(c),
    }));
    const { error } = await sb.from('acc_forecast_pnl').upsert(rows, { onConflict: 'company_id,month' });
    if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  const kept: SupplierGrid = suppliers ?? Object.fromEntries(Object.entries(current.suppliers).filter(([m]) => m in checked.grid));
  return c.json({ ok: true, months: checked.grid, suppliers: kept, removed });
};

export const forecastFiguresHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_READ, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!FORECAST_MONTH_RE.test(from) || !FORECAST_MONTH_RE.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM, from on or before to.' }, 400);
  }
  const sb = c.get('supabase');
  const [accs, grid] = await Promise.all([loadForecastAccounts(sb, co.companyId), loadGrid(sb, co.companyId)]);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!grid.ok) return c.json({ error: 'load_failed', reason: grid.reason }, 500);
  const months = sortedMonths(grid.grid).filter((m) => m >= from && m <= to);
  return c.json({ from, to, months: months.map((m) => ({ month: m, ...monthFigures(grid.grid[m] ?? {}, grid.suppliers[m] ?? {}, accs.accounts) })) });
};
