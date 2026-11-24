// ----------------------------------------------------------------------------
// accounting-cashflow-forecast — the Cash Flow's P&L forecast column (step 2
// of the Hookka forecast port, docs/forecast-port-spec.md part 1; owner
// 2026-11-24 「开始做第 2 步」).
//
//   GET /accounting/reports/cash-flow-forecast?from=YYYY-MM&to=YYYY-MM
//
// Each month of the range — and, when the range reaches the current month,
// every later month the forecast's money reaches (a year at most) — as a Cash
// Flow report of its own: the Forecast P&L as cash (acc/cashflow-pnl-forecast)
// laid on the Cash Flow's own tree by the same layOutCashFlow the actual
// report uses, so a forecast figure sits on the line the actual money sits on
// (a purchase on its purchase account, an expense on its account, the
// customers' money under the debtor control's Deposit and Settlement). The
// column is the report's one money column, FORECAST; its entries say where
// each figure comes from. The page rolls Balance b/f and c/f through it from
// the actual reports it reads beside it.
//
// The timings are measured over the 3 complete months before today: the
// customers' receipts against their order month (imported and converted
// payments and mirror rows left out — owner 2026-11-24, D2), the supplier
// bills (PI and AP invoices) per purchase account and supplier. Every read
// carries the active company's predicate. The statements' read key. Nothing
// stored; the Worker keeps an answer 60 s per company and query, as the
// Dashboard does.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { resolveRoles } from '../../acc/rules';
import { codesUnder, layOutCashFlow, type LaidNode, type LayoutItem, type SplitTo } from '../../acc/report-layout';
import { loadOrderPaymentFacts, paymentKinds } from '../../acc/order-payment-kind';
import { STAFF_COST_CATEGORY_ID } from '../../acc/dashboard';
import {
  buildPnlCashLegs, forecastMonths, measuredWindow, monthsBetween, parseTermMonths, receiptMixOf, termMixOf,
  type CashLeg, type ReceiptMix, type TermInfo, type TermMix,
} from '../../acc/cashflow-pnl-forecast';
import { isPurchaseAccount } from '../shared/forecast-pnl';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import { cashFlowLines, type RpEntry, type RpRow } from './accounting-rp';
import { loadForecastAccounts, loadGrid, loadSupplierBills, loadSupplierMaster, netBilledBySupplier, type SupplierMasterRow } from './accounting-forecast';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
type Fail = { ok: false; reason: string };

const READ_PERM = 'scm.payment_voucher.post';
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The forecast's one money column. */
export const FORECAST_COLUMN = 'FORECAST';
const FORECAST_COLUMN_NAME = 'P&L forecast';
/** Customer payments that are not customers' money coming in: carried over from AutoCount, moved between orders. */
const NOT_RECEIPTS = new Set(['imported', 'converted']);
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);
/** A layout's block by its key — a block the tree does not carry is empty. */
const blockOf = (blocks: Partial<Record<string, LayoutItem[]>>, key: string): LayoutItem[] => blocks[key] ?? [];

/** One month's forecast as the Cash Flow report's own shape — the page lays it beside the month's actual. */
export type ForecastMonthReport = {
  from: string; to: string; byParty: false;
  columns: Array<{ code: string; name: string }>;
  opening: Record<string, number>;
  receipts: RpRow[]; payments: RpRow[];
  layout: { stored: boolean; tree: LaidNode[]; inSen: number; outSen: number };
  totals: {
    receipts: Record<string, number>; payments: Record<string, number>; closing: Record<string, number>;
    openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number;
  };
  entries: RpEntry[];
  card: { takingsSen: number; transitSen: number; codes: string[] };
};

export type CashFlowForecastPayload = {
  from: string; to: string; currentMonth: string;
  months: Array<{ month: string; future: boolean; report: ForecastMonthReport }>;
  /** What the timings were measured over. */
  measured: { from: string; to: string };
  /** The customers' money by kind and delay after the order month, in % of what came in. */
  receiptMix: Array<{ kind: 'DEP' | 'BAL'; months: number; pct: number }>;
  /** Suppliers timed a month later for want of a usable payment term. */
  flagged: Array<{ id: string; code: string; name: string }>;
  /** Forecast lines left out as moving no cash. */
  nonCash: Array<{ code: string; name: string }>;
};

const monthEnd = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** One month's legs as the report's rows, entries, tree and totals. */
export function forecastMonthReport(month: string, legs: readonly CashLeg[], tree: LayoutItem[], stored: boolean, companyId: number): ForecastMonthReport {
  const receipts = new Map<string, RpRow>();
  const payments = new Map<string, RpRow>();
  const entries: RpEntry[] = [];
  for (const l of legs) {
    const book = l.flow === 'in' ? receipts : payments;
    const splitTo: SplitTo | undefined = l.group ? (l.group.id === 'DEP' ? 'deposit' : 'settlement') : undefined;
    const row: RpRow = book.get(l.key) ?? { key: l.key, code: l.code, name: l.name, cells: {}, totalSen: 0, ...(l.group ? { group: { id: l.group.id, label: l.group.label } } : {}), ...(splitTo ? { splitTo } : {}) };
    row.cells[FORECAST_COLUMN] = (row.cells[FORECAST_COLUMN] ?? 0) + l.sen;
    row.totalSen += l.sen;
    book.set(l.key, row);
    entries.push({
      jeNo: '', entryDate: `${month}-01`, sourceType: 'FORECAST', sourceDocNo: l.fromYm, narration: l.note,
      party: l.party, side: l.flow === 'in' ? 'R' : 'P', rowKey: l.key, column: FORECAST_COLUMN, sen: l.sen,
    });
  }
  /* By code, the debtor control's Deposit before its Settlement — the actual report's order. */
  const rank = (r: RpRow): number => (r.group?.id === 'DEP' ? 0 : r.group?.id === 'BAL' ? 1 : 2);
  const byKey = (m: Map<string, RpRow>): RpRow[] => [...m.values()].filter((r) => r.totalSen !== 0)
    .sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')) || rank(a) - rank(b) || a.key.localeCompare(b.key));
  const receiptRows = byKey(receipts);
  const paymentRows = byKey(payments);
  const cf = layOutCashFlow(tree, cashFlowLines(receiptRows), cashFlowLines(paymentRows), companyId);
  const inSen = receiptRows.reduce((s, r) => s + r.totalSen, 0);
  const outSen = paymentRows.reduce((s, r) => s + r.totalSen, 0);
  return {
    from: `${month}-01`, to: monthEnd(month), byParty: false,
    columns: [{ code: FORECAST_COLUMN, name: FORECAST_COLUMN_NAME }],
    opening: { [FORECAST_COLUMN]: 0 },
    receipts: receiptRows, payments: paymentRows,
    layout: { stored, tree: cf.nodes, inSen: cf.inSen, outSen: cf.outSen },
    totals: {
      receipts: { [FORECAST_COLUMN]: inSen }, payments: { [FORECAST_COLUMN]: outSen }, closing: { [FORECAST_COLUMN]: inSen - outSen },
      openingTotalSen: 0, receiptsTotalSen: inSen, paymentsTotalSen: outSen, closingTotalSen: inSen - outSen,
    },
    entries,
    card: { takingsSen: 0, transitSen: 0, codes: [] },
  };
}

type PaymentRow = { id: string; so_doc_no: string; amount_sen: number | null; paid_at: string | null; method: string | null; mirror_of_payment_id: string | null };

/** The customers' money of the measured window by kind and delay after its order month. */
async function loadReceiptMix(sb: Sb, companyId: number, win: { from: string; to: string }): Promise<{ ok: true; mix: ReceiptMix } | Fail> {
  const paid = await paginateAll<PaymentRow>((f: number, t: number) => sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, amount_sen, paid_at, method, mirror_of_payment_id')
    .eq('company_id', companyId).gte('paid_at', win.from).lte('paid_at', win.to).order('id').range(f, t));
  if (paid.error) return { ok: false, reason: `order payments: ${failed(paid.error)}` };
  const kept = (paid.data ?? []).filter((p) => !NOT_RECEIPTS.has(String(p.method ?? '').toLowerCase()) && p.mirror_of_payment_id == null && Number(p.amount_sen ?? 0) > 0 && p.paid_at);
  if (kept.length === 0) return { ok: true, mix: receiptMixOf([]) };
  const docs = [...new Set(kept.map((p) => String(p.so_doc_no)))];
  const [orders, facts] = await Promise.all([
    chunkIn<{ doc_no: string; so_date: string | null }>(docs, (batch, f, t) =>
      sb.from('mfg_sales_orders').select('doc_no, so_date').eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(f, t)),
    loadOrderPaymentFacts(sb, companyId, kept.map((p) => String(p.id))),
  ]);
  if (orders.error) return { ok: false, reason: `orders: ${failed(orders.error)}` };
  if (!facts.ok) return { ok: false, reason: facts.reason };
  const orderMonth = new Map(orders.data.map((o) => [String(o.doc_no), String(o.so_date ?? '').slice(0, 7)]));
  const kinds = paymentKinds(facts.facts);
  const rows = kept.flatMap((p) => {
    const om = orderMonth.get(String(p.so_doc_no));
    if (!om || !MONTH.test(om)) return [];
    return [{ kind: kinds.get(String(p.id)) ?? 'DEP' as const, months: monthsBetween(om, String(p.paid_at).slice(0, 7)), sen: Number(p.amount_sen) }];
  });
  return { ok: true, mix: receiptMixOf(rows) };
}

export async function buildCashFlowForecast(sb: Sb, companyId: number, layoutIds: number[], from: string, to: string, today: string): Promise<{ ok: true; payload: CashFlowForecastPayload } | Fail> {
  const win = measuredWindow(today);
  const [accs, grid, rpLayout, pnlLayout, roles, master, bills, receipts] = await Promise.all([
    loadForecastAccounts(sb, companyId),
    loadGrid(sb, companyId),
    resolveLayout(sb, layoutIds, 'rp'),
    resolveLayout(sb, layoutIds, 'pnl'),
    resolveRoles(sb, companyId),
    loadSupplierMaster(sb, companyId),
    loadSupplierBills(sb, companyId, win.from, win.to),
    loadReceiptMix(sb, companyId, win),
  ]);
  if (!accs.ok) return { ok: false, reason: `forecast accounts: ${accs.reason}` };
  if (!grid.ok) return { ok: false, reason: `forecast: ${grid.reason}` };
  if (!rpLayout.ok) return { ok: false, reason: rpLayout.reason };
  if (!pnlLayout.ok) return { ok: false, reason: pnlLayout.reason };
  if (!master.ok) return { ok: false, reason: master.reason };
  if (!bills.ok) return { ok: false, reason: bills.reason };
  if (!receipts.ok) return { ok: false, reason: receipts.reason };

  const byId = new Map(master.rows.map((s) => [String(s.id), s]));
  const byCode = new Map(master.rows.map((s) => [String(s.code), s]));
  const termOf = (s: SupplierMasterRow | undefined): TermInfo => parseTermMonths(s?.payment_terms ?? null);
  const flaggedIds = new Set<string>();
  /* A purchase line keyed whole: by what each recent supplier billed it, each after its own term. */
  const billed = netBilledBySupplier(bills.rows, new Set(accs.accounts.filter(isPurchaseAccount).map((a) => a.code)));
  const mixOf = new Map<string, TermMix>();
  const purchaseMix = (code: string): TermMix => {
    const hit = mixOf.get(code);
    if (hit) return hit;
    const rows: Array<{ months: number; sen: number }> = [];
    for (const [supplierCode, by] of billed) {
      const sen = by.get(code) ?? 0;
      if (sen <= 0) continue;
      const s = byCode.get(supplierCode);
      const term = termOf(s);
      if (term.flagged && s) flaggedIds.add(String(s.id));
      rows.push({ months: term.months, sen });
    }
    const mix = termMixOf(rows);
    mixOf.set(code, mix);
    return mix;
  };
  const salaryCodes = new Set(codesUnder(blockOf(pnlLayout.layout.blocks, 'expenses'), STAFF_COST_CATEGORY_ID));
  const built = buildPnlCashLegs({
    grid: grid.grid, suppliers: grid.suppliers, accounts: accs.accounts, arCode: roles.AR,
    receiptMix: receipts.mix, purchaseMix,
    supplierTerm: (id) => termOf(byId.get(id)),
    supplierName: (id) => String(byId.get(id)?.name ?? `Unknown supplier (${id})`),
    salaryCodes,
  });
  for (const id of built.flagged) flaggedIds.add(id);

  const currentMonth = today.slice(0, 7);
  const tree = blockOf(rpLayout.layout.blocks, 'accounts');
  const months = forecastMonths(from, to, currentMonth, built.legs).map(({ month, future }) => ({
    month, future, report: forecastMonthReport(month, built.legs.filter((l) => l.ym === month), tree, rpLayout.stored, companyId),
  }));
  const mixTotal = receipts.mix.reduce((s, m) => s + m.weight, 0);
  return {
    ok: true,
    payload: {
      from, to, currentMonth, months,
      measured: win,
      receiptMix: receipts.mix.map((m) => ({ kind: m.kind, months: m.months, pct: mixTotal > 0 ? Math.round((m.weight / mixTotal) * 1000) / 10 : 0 })),
      flagged: [...flaggedIds].map((id) => byId.get(id)).filter((s): s is SupplierMasterRow => s !== undefined)
        .map((s) => ({ id: String(s.id), code: String(s.code), name: String(s.name ?? s.code) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
      nonCash: built.nonCash,
    },
  };
}

/* ── The door, with its 60-second memory (the Dashboard's) ──────────────── */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;
const cache = new Map<string, { at: number; payload: CashFlowForecastPayload }>();
/** For the tests. */
export const clearCashFlowForecastCache = (): void => cache.clear();

export const cashFlowForecastHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!MONTH.test(from) || !MONTH.test(to) || from > to || monthsBetween(from, to) > 35) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM, from on or before to, at most 36 months.' }, 400);
  }
  const ids = allowedIds(c);
  const today = todayMyt();
  const key = [co.companyId, ids.join('.'), from, to, today].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return c.json({ ...hit.payload, cached: true });
  const r = await buildCashFlowForecast(c.get('supabase'), co.companyId, ids, from, to, today);
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), payload: r.payload });
  return c.json(r.payload);
};

