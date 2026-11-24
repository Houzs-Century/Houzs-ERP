// ----------------------------------------------------------------------------
// accounting-cashflow-forecast — the Cash Flow's P&L forecast column (step 2
// of the Hookka forecast port, docs/forecast-port-spec.md part 1; owner
// 2026-11-24 「开始做第 2 步」).
//
//   GET /accounting/reports/cash-flow-forecast?from=YYYY-MM&to=YYYY-MM
//   GET /accounting/reports/cash-flow-forecast/inputs       the Capex & financing table (step 3)
//   PUT /accounting/reports/cash-flow-forecast/inputs { months }  the whole table, replaced
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
// The Capex & financing table (step 3, docs/forecast-port-spec.md part 2;
// acc/forecast-inputs): amounts Finance keys per account and month for the
// accounts the Cash Flow layout places under FUNDING IN / (OUT), trade finance
// aside — + money in, − money out — kept in scm.acc_forecast_inputs and shown
// in the forecast column on their own account in their own month, a past
// month beside its actual. Writing takes the vouchers' write key; a save
// replaces the company's whole table and refuses, by name, an account the
// layout no longer offers.
//
// The Orders & bills column (step 4, docs/forecast-port-spec.md part 1 `fc:`;
// acc/cashflow-docs-forecast): the money already in hand — an open order's
// unpaid balance in its delivery month, what the books say each supplier is
// owed on its newest bills when they fall due, the Forecast P&L's other lines,
// the Capex & financing table — for the current month as it stood on its 1st
// and the later months from today's orders and bills. Only when the range
// reaches the current month; `docs` is null otherwise.
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
import { codesUnder, layOutBlock, layOutCashFlow, type LaidNode, type LayoutItem, type SplitTo } from '../../acc/report-layout';
import { loadOrderPaymentFacts, paymentKinds } from '../../acc/order-payment-kind';
import { STAFF_COST_CATEGORY_ID } from '../../acc/dashboard';
import {
  FORECAST_MONTHS_AHEAD, addMonthsYm, buildPnlCashLegs, forecastMonths, isNonCashName, measuredWindow, monthsBetween, parseTermMonths, receiptMixOf, termMixOf,
  type CashLeg, type ReceiptMix, type TermInfo, type TermMix,
} from '../../acc/cashflow-pnl-forecast';
import { billMonth, buildDocsLegs, owedBills, type DueBill, type OpenOrder, type OwedBill } from '../../acc/cashflow-docs-forecast';
import {
  DEFAULT_TENOR_DAYS, defaultRateBp, isFacilityAccount, lenderOf, openDraws, supplierDues, tfPlan,
  type Dues, type FacilityLine, type Off, type OpenDraw, type TfMonth,
} from '../../acc/trade-finance-forecast';
import { ageEntries } from '../../acc/aging';
import { loadApAging } from '../../acc/aging-load';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { KEYED_MONTHS, keyableAccounts, keyedInputLegs, keyedNotOffered, validateKeyedInputs, type KeyableAccount, type KeyedInputs } from '../../acc/forecast-inputs';
import { OTHER_SUPPLIER, blockOfSection, isPurchaseAccount, monthFigures, type ForecastAccount, type ForecastGrid, type SupplierGrid } from '../shared/forecast-pnl';
import { SO_NOT_AN_ORDER } from '../shared/so-deliverable-states';
import { allowedIds, resolveLayout } from './accounting-report-layouts';
import { buildBalanceSheet, dbSources, type BalanceSheetReport } from './accounting-reports';
import { FC_PROFIT, bsDeltas, capReceipts, cumulate, forecastSheet, type Accrual, type BsMove, type Side, type StartSheet } from '../../acc/forecast-balance-sheet';
import { cashFlowLines, type RpEntry, type RpRow } from './accounting-rp';
import { loadForecastAccounts, loadGrid, loadSupplierBills, loadSupplierMaster, netBilledBySupplier, type SupplierMasterRow } from './accounting-forecast';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
type Fail = { ok: false; reason: string };

const READ_PERM = 'scm.payment_voucher.post';
const WRITE_PERM = 'scm.payment_voucher.write';
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const NO_WRITE = { error: "You don't have permission to change the forecast." };
const who = (c: Ctx): string => String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? '');
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The forecast's one money column. */
export const FORECAST_COLUMN = 'FORECAST';
const PNL_COLUMN_NAME = 'P&L forecast';
const DOCS_COLUMN_NAME = 'Orders & bills';
/** What a forecast figure's entry says it came from. */
const SOURCE_TYPE: Record<CashLeg['source'], string> = { pnl: 'FORECAST', input: 'FORECAST_INPUT', order: 'FORECAST_ORDER', bill: 'FORECAST_BILL', tf: 'FORECAST_TF' };
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
  /** The Orders & bills column: the current month as at its 1st, then each later month the
      orders and bills reach; null when the range ends before the current month. */
  docs: {
    months: Array<{ month: string; future: boolean; report: ForecastMonthReport }>;
    /** The day the current month's orders and bills are taken as at. */
    asAt: string;
    /** Open orders with no delivery date, by the year ordered: in no month. */
    undated: Array<{ year: string; orders: number; sen: number }>;
    /** Orders and bills expected after the last month shown. */
    beyond: { orders: number; orderSen: number; bills: number; billSen: number };
    /** Suppliers a bill of which was timed a month later for want of a payment term. */
    flagged: string[];
  } | null;
  /** The trade-finance plan in both forecasts (step 5); null when the range ends before the
      current month or the company has no facility. */
  tf: {
    facilities: Array<{ code: string; lender: string; tenorDays: number; rateBp: number; owedNowSen: number; suppliers: string[] }>;
    /** The Forecast P&L's interest lines left out: the interest comes with each repayment. */
    interestLeftOut: Array<{ code: string; name: string }>;
  } | null;
};

const monthEnd = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** One month's legs as the report's rows, entries, tree and totals. */
export function forecastMonthReport(month: string, legs: readonly CashLeg[], tree: LayoutItem[], stored: boolean, companyId: number, columnName: string): ForecastMonthReport {
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
      jeNo: '', entryDate: `${month}-01`, sourceType: SOURCE_TYPE[l.source], sourceDocNo: l.ref ?? l.fromYm, narration: l.note,
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
    columns: [{ code: FORECAST_COLUMN, name: columnName }],
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

type Chart = {
  names: Map<string, string>; money: Set<string>; facilities: Array<{ code: string; name: string; lender: string }>;
  /** Every account's type and section — where the Forecast Balance Sheet files an account new to it. */
  kinds: Map<string, { name: string; type: string; section: string | null }>;
};
/** The company's active leaf accounts, code → name: what a keyed amount may name and is called by; its
    bank and cash accounts; its trade-finance facilities (a liability named TRADE FINANCE). */
async function loadChartLeaves(sb: Sb, companyId: number): Promise<({ ok: true } & Chart) | Fail> {
  const { data, error } = await sb.from('accounts').select('account_code, account_name, account_type, section, parent_code, is_active, acc_money').eq('company_id', companyId);
  if (error) return { ok: false, reason: `chart: ${failed(error)}` };
  const rows = (data ?? []) as Array<{ account_code: string; account_name: string | null; account_type: string | null; section: string | null; parent_code: string | null; is_active: boolean | null; acc_money: boolean | null }>;
  const parents = new Set(rows.map((r) => r.parent_code).filter((p): p is string => p != null && p !== ''));
  const leaves = rows.filter((r) => r.is_active !== false && !parents.has(r.account_code));
  return {
    ok: true,
    names: new Map(leaves.map((r) => [r.account_code, r.account_name ?? r.account_code])),
    money: new Set(rows.filter((r) => r.acc_money === true).map((r) => r.account_code)),
    facilities: leaves.filter((r) => isFacilityAccount({ name: r.account_name ?? '', type: r.account_type, money: r.acc_money === true }))
      .map((r) => ({ code: r.account_code, name: r.account_name ?? r.account_code, lender: lenderOf(r.account_name ?? r.account_code) })),
    kinds: new Map(rows.map((r) => [r.account_code, { name: r.account_name ?? r.account_code, type: String(r.account_type ?? '').toUpperCase(), section: r.section }])),
  };
}

/** The company's Capex & financing table as stored. */
async function loadForecastInputs(sb: Sb, companyId: number): Promise<{ ok: true; months: KeyedInputs } | Fail> {
  const { data, error } = await sb.from('acc_forecast_inputs').select('month, account_code, amount_sen').eq('company_id', companyId);
  if (error) return { ok: false, reason: `capex and financing: ${failed(error)}` };
  const months: KeyedInputs = {};
  for (const r of (data ?? []) as Array<{ month: string; account_code: string; amount_sen: number | string }>) {
    const sen = Number(r.amount_sen);
    if (sen) (months[String(r.month)] ??= {})[String(r.account_code)] = sen;
  }
  return { ok: true, months };
}

/* ── The Orders & bills column (step 4) ───────────────────────────────────── */

type OrderRow = {
  doc_no: string; so_date: string | null; debtor_name: string | null; balance_sen: number | string | null; status: string | null;
  amended_delivery_date: string | null; customer_delivery_date: string | null;
};
const ORDER_COLS = 'doc_no, so_date, debtor_name, balance_sen, status, amended_delivery_date, customer_delivery_date';
/** No money to come: not an order (a draft, a cancelled one), or one whose remainder was given up (closed). */
const NOT_OPEN: ReadonlySet<string> = new Set([...SO_NOT_AN_ORDER, 'CLOSED']);

/** The open orders today, and as they stood on the current month's 1st:
    today's balance with what was paid on it since added back; an order placed
    since then left out. */
async function loadOpenOrders(sb: Sb, companyId: number, first: string): Promise<{ ok: true; live: OpenOrder[]; baseline: OpenOrder[] } | Fail> {
  const [open, paid] = await Promise.all([
    paginateAll<OrderRow>((f: number, t: number) => sb.from('mfg_sales_orders').select(ORDER_COLS)
      .eq('company_id', companyId).gt('balance_sen', 0).order('doc_no').range(f, t)),
    paginateAll<{ id: string; so_doc_no: string; amount_sen: number | string | null }>((f: number, t: number) => sb.from('mfg_sales_order_payments')
      .select('id, so_doc_no, amount_sen').eq('company_id', companyId).gte('paid_at', first).order('id').range(f, t)),
  ]);
  if (open.error) return { ok: false, reason: `open orders: ${failed(open.error)}` };
  if (paid.error) return { ok: false, reason: `order payments: ${failed(paid.error)}` };
  const since = new Map<string, number>();
  for (const p of paid.data ?? []) since.set(String(p.so_doc_no), (since.get(String(p.so_doc_no)) ?? 0) + Number(p.amount_sen ?? 0));
  const rows = new Map((open.data ?? []).map((o) => [String(o.doc_no), o]));
  /* An order paid off since the 1st is not open today, but it was then. */
  const more = [...since.keys()].filter((d) => !rows.has(d));
  if (more.length > 0) {
    const got = await chunkIn<OrderRow>(more, (batch, f, t) => sb.from('mfg_sales_orders').select(ORDER_COLS)
      .eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(f, t));
    if (got.error) return { ok: false, reason: `orders: ${failed(got.error)}` };
    for (const o of got.data) rows.set(String(o.doc_no), o);
  }
  const live: OpenOrder[] = [];
  const baseline: OpenOrder[] = [];
  for (const o of rows.values()) {
    if (NOT_OPEN.has(String(o.status ?? '').toUpperCase())) continue;
    const base = { docNo: String(o.doc_no), soDate: String(o.so_date ?? ''), customer: String(o.debtor_name ?? o.doc_no), deliveryDate: o.amended_delivery_date ?? o.customer_delivery_date ?? null };
    const now = Number(o.balance_sen ?? 0);
    if (now > 0) live.push({ ...base, balanceSen: now });
    const then = now + (since.get(base.docNo) ?? 0);
    if (base.soDate !== '' && base.soDate < first && then > 0) baseline.push({ ...base, balanceSen: then });
  }
  return { ok: true, live, baseline };
}

/** The bills the books owe as at a day: the formal AP Aging, each supplier's unapplied money on its oldest bills. */
async function loadOwedBills(sb: Sb, companyId: number, codes: string[], asOf: string): Promise<{ ok: true; bills: OwedBill[] } | Fail> {
  const loaded = await loadApAging(sb, companyId, codes, asOf);
  if (!loaded.ok) return { ok: false, reason: `supplier aging: ${loaded.reason}` };
  return { ok: true, bills: owedBills(ageEntries(loaded.entries, { asOf, basis: 'invoice', buckets: 'month' })) };
}

type GlRow = { source_doc_no: string | null; account_code: string; account_name: string | null; debit_sen: number | string | null; posted: boolean | null; reversed: boolean | null; reversed_by_je: string | null };

/** What times and places each owed bill: its plan (Bills to pay), the accounts
    it was bought on — a PI's own journal debits off the control, an AP
    invoice's lines, as an actual supplier payment reads (rule A) — and its
    supplier's payment term. */
async function billFacts(
  sb: Sb, companyId: number, owed: readonly OwedBill[], controls: ReadonlySet<string>,
  nameOf: (code: string) => string, termOf: (supplierCode: string | null) => TermInfo,
): Promise<{ ok: true; due: (b: OwedBill) => DueBill } | Fail> {
  const piNos = [...new Set(owed.filter((b) => b.kind === 'PI').map((b) => b.docNo))];
  const apiNos = [...new Set(owed.filter((b) => b.kind === 'API').map((b) => b.docNo))];
  const [pis, apis, piLines] = await Promise.all([
    chunkIn<{ id: string; invoice_number: string }>(piNos, (batch, f, t) => sb.from('purchase_invoices').select('id, invoice_number')
      .eq('company_id', companyId).in('invoice_number', batch).order('id').range(f, t)),
    chunkIn<{ id: string; invoice_number: string }>(apiNos, (batch, f, t) => sb.from('ap_invoices').select('id, invoice_number')
      .eq('company_id', companyId).in('invoice_number', batch).order('id').range(f, t)),
    chunkIn<GlRow>(piNos, (batch, f, t) => sb.from('v_gl_entries').select('source_doc_no, account_code, account_name, debit_sen, posted, reversed, reversed_by_je')
      .eq('company_id', companyId).eq('source_type', 'PI').in('source_doc_no', batch).order('line_id').range(f, t)),
  ]);
  if (pis.error) return { ok: false, reason: `purchase invoices: ${failed(pis.error)}` };
  if (apis.error) return { ok: false, reason: `AP invoices: ${failed(apis.error)}` };
  if (piLines.error) return { ok: false, reason: `purchase invoice journals: ${failed(piLines.error)}` };
  const piId = new Map(pis.data.map((p) => [String(p.invoice_number), String(p.id)]));
  const apiId = new Map(apis.data.map((a) => [String(a.invoice_number), String(a.id)]));
  const [plans, apiLines] = await Promise.all([
    chunkIn<{ bill_kind: string; bill_id: string; planned_on: string | null }>([...piId.values(), ...apiId.values()], (batch, f, t) => sb.from('acc_bill_plans')
      .select('bill_kind, bill_id, planned_on').eq('company_id', companyId).in('bill_id', batch).order('bill_id').range(f, t)),
    chunkIn<{ invoice_id: string; debit_account_code: string; amount_sen: number | string | null }>([...apiId.values()], (batch, f, t) => sb.from('ap_invoice_lines')
      .select('invoice_id, debit_account_code, amount_sen').eq('company_id', companyId).in('invoice_id', batch).order('invoice_id').range(f, t)),
  ]);
  if (plans.error) return { ok: false, reason: `bill plans: ${failed(plans.error)}` };
  if (apiLines.error) return { ok: false, reason: `AP invoice lines: ${failed(apiLines.error)}` };
  const planOf = new Map(plans.data.map((p) => [`${p.bill_kind}:${p.bill_id}`, p.planned_on]));
  const parts = new Map<string, Array<{ code: string; name: string; sen: number }>>();
  const add = (bill: string, code: string, name: string, sen: number): void => {
    if (!(sen > 0)) return;
    const list = parts.get(bill) ?? [];
    list.push({ code, name, sen });
    parts.set(bill, list);
  };
  for (const l of piLines.data) {
    if (!countsInTheBooks(l) || controls.has(l.account_code)) continue;
    add(`PI:${String(l.source_doc_no)}`, l.account_code, l.account_name ?? nameOf(l.account_code), Number(l.debit_sen ?? 0));
  }
  const apiNoById = new Map([...apiId].map(([no, id]) => [id, no]));
  for (const l of apiLines.data) add(`API:${apiNoById.get(String(l.invoice_id)) ?? ''}`, l.debit_account_code, nameOf(l.debit_account_code), Number(l.amount_sen ?? 0));
  return {
    ok: true,
    due: (b) => {
      const id = b.kind === 'PI' ? piId.get(b.docNo) : b.kind === 'API' ? apiId.get(b.docNo) : undefined;
      return { ...b, plannedOn: id ? (planOf.get(`${b.kind}:${id}`) ?? null) : null, term: termOf(b.supplierCode), parts: parts.get(`${b.kind}:${b.docNo}`) ?? [] };
    },
  };
}

/** The bills the books owe today, each timed and placed. */
async function loadNowBills(sb: Sb, companyId: number, a: { today: string; controls: string[]; nameOf: (code: string) => string; termOf: (supplierCode: string | null) => TermInfo }): Promise<{ ok: true; bills: DueBill[] } | Fail> {
  const now = await loadOwedBills(sb, companyId, a.controls, a.today);
  if (!now.ok) return now;
  const facts = await billFacts(sb, companyId, now.bills, new Set(a.controls), a.nameOf, a.termOf);
  if (!facts.ok) return facts;
  return { ok: true, bills: now.bills.map(facts.due) };
}

type DocsFacts = { orders: { live: OpenOrder[]; baseline: OpenOrder[] }; then: DueBill[]; now: DueBill[] };

/** What the Orders & bills column reads: the open orders today and on the current month's 1st, the bills owed then and today. */
async function loadDocsFacts(sb: Sb, companyId: number, a: {
  today: string; currentMonth: string; controls: string[]; nameOf: (code: string) => string; termOf: (supplierCode: string | null) => TermInfo;
}): Promise<({ ok: true } & DocsFacts) | Fail> {
  const first = `${a.currentMonth}-01`;
  const [orders, then, now] = await Promise.all([
    loadOpenOrders(sb, companyId, first),
    loadOwedBills(sb, companyId, a.controls, monthEnd(addMonthsYm(a.currentMonth, -1))),
    loadOwedBills(sb, companyId, a.controls, a.today),
  ]);
  if (!orders.ok) return orders;
  if (!then.ok) return then;
  if (!now.ok) return now;
  const facts = await billFacts(sb, companyId, [...then.bills, ...now.bills], new Set(a.controls), a.nameOf, a.termOf);
  if (!facts.ok) return facts;
  return { ok: true, orders, then: then.bills.map(facts.due), now: now.bills.map(facts.due) };
}

/** The Orders & bills column's months, as Cash Flow reports on the same tree. */
function docsColumn(companyId: number, facts: DocsFacts, a: {
  currentMonth: string; ar: string; ap: string; nameOf: (code: string) => string; tree: LayoutItem[]; stored: boolean; costs: CashLeg[]; inputs: CashLeg[];
}): NonNullable<CashFlowForecastPayload['docs']> {
  const built = buildDocsLegs({
    currentYm: a.currentMonth, lastYm: addMonthsYm(a.currentMonth, FORECAST_MONTHS_AHEAD),
    arCode: a.ar, ap: { code: a.ap, name: a.nameOf(a.ap) },
    baseline: { orders: facts.orders.baseline, bills: facts.then },
    live: { orders: facts.orders.live, bills: facts.now },
    costs: a.costs, inputs: a.inputs,
  });
  return {
    months: built.months.map((month) => ({
      month, future: month > a.currentMonth,
      report: forecastMonthReport(month, built.legs.filter((l) => l.ym === month), a.tree, a.stored, companyId, DOCS_COLUMN_NAME),
    })),
    asAt: `${a.currentMonth}-01`, undated: built.undated, beyond: built.beyond, flagged: built.flagged,
  };
}

/* ── The trade-finance plan (step 5) ──────────────────────────────────────── */

/** One facility as the Trade finance table shows it and the forecasts use it. */
export type TfFacilityPayload = {
  code: string; name: string; lender: string;
  /** Finance's own tenor and rate per draw; null = the default. */
  tenorSet: number | null; rateSet: number | null;
  tenorDays: number; rateBp: number;
  /** The last six repayments' interest over their principal. */
  defaultRateBp: number;
  /** Where the repayment vouchers book the interest. */
  interest: { code: string; name: string } | null;
  owedNowSen: number;
  /** The draws still owed, oldest first. */
  open: OpenDraw[];
  /** The suppliers the facility pays, and the months unticked by hand. */
  suppliers: string[];
  off: Off;
  /** Every supplier's dues by month — the chosen ones are drawn. */
  dues: Dues;
  schedule: TfMonth[];
};

type GlMoveRow = { je_no: string; entry_date: string; account_code: string; debit_sen: number | string | null; credit_sen: number | string | null; posted: boolean | null; reversed: boolean | null; reversed_by_je: string | null };
const GL_MOVE_COLS = 'je_no, entry_date, account_code, debit_sen, credit_sen, posted, reversed, reversed_by_je';
const ids = (raw: unknown): string[] => (Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))] : []);
const offOf = (raw: unknown): Off => {
  const out: Off = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [ym, list] of Object.entries(raw as Record<string, unknown>)) {
      const clean = ids(list);
      if (MONTH.test(ym) && clean.length > 0) out[ym] = clean;
    }
  }
  return out;
};

/** Each facility's lines as at today and its repayments: the principal, and the interest
    booked beside it (a debit on neither the facility nor a bank or cash account). */
async function loadFacilityBooks(sb: Sb, companyId: number, codes: string[], money: ReadonlySet<string>, today: string): Promise<{
  ok: true; lines: Map<string, FacilityLine[]>; repayments: Map<string, Array<{ date: string; principalSen: number; interestSen: number }>>; interestCode: Map<string, string>;
} | Fail> {
  const got = await paginateAll<GlMoveRow>((f: number, t: number) => sb.from('v_gl_entries').select(GL_MOVE_COLS)
    .eq('company_id', companyId).in('account_code', codes).lte('entry_date', today).order('line_id').range(f, t));
  if (got.error) return { ok: false, reason: `trade finance: ${failed(got.error)}` };
  const own = (got.data ?? []).filter((l) => countsInTheBooks(l));
  const lines = new Map<string, FacilityLine[]>();
  const repaidIn = new Map<string, string>();
  for (const l of own) {
    const list = lines.get(l.account_code) ?? [];
    list.push({ date: String(l.entry_date).slice(0, 10), debitSen: Number(l.debit_sen ?? 0), creditSen: Number(l.credit_sen ?? 0) });
    lines.set(l.account_code, list);
    if (Number(l.debit_sen ?? 0) > 0) repaidIn.set(l.je_no, l.account_code);
  }
  const repayments = new Map<string, Array<{ date: string; principalSen: number; interestSen: number }>>();
  const interestCode = new Map<string, string>();
  if (repaidIn.size === 0) return { ok: true, lines, repayments, interestCode };
  const jes = await chunkIn<GlMoveRow>([...repaidIn.keys()], (batch, f, t) => sb.from('v_gl_entries').select(GL_MOVE_COLS)
    .eq('company_id', companyId).in('je_no', batch).order('line_id').range(f, t));
  if (jes.error) return { ok: false, reason: `trade finance repayments: ${failed(jes.error)}` };
  const byJe = new Map<string, GlMoveRow[]>();
  for (const l of jes.data.filter((x) => countsInTheBooks(x))) byJe.set(l.je_no, [...(byJe.get(l.je_no) ?? []), l]);
  const counts = new Map<string, Map<string, number>>();
  for (const [je, code] of repaidIn) {
    const ls = byJe.get(je) ?? [];
    let principalSen = 0;
    let interestSen = 0;
    for (const l of ls) {
      const dr = Number(l.debit_sen ?? 0);
      if (dr <= 0) continue;
      if (l.account_code === code) { principalSen += dr; continue; }
      if (money.has(l.account_code) || codes.includes(l.account_code)) continue;
      interestSen += dr;
      const c = counts.get(code) ?? new Map<string, number>();
      c.set(l.account_code, (c.get(l.account_code) ?? 0) + 1);
      counts.set(code, c);
    }
    const list = repayments.get(code) ?? [];
    list.push({ date: String(ls[0]?.entry_date ?? '').slice(0, 10), principalSen, interestSen });
    repayments.set(code, list);
  }
  for (const [code, c] of counts) {
    const top = [...c].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).at(0);
    if (top) interestCode.set(code, top[0]);
  }
  return { ok: true, lines, repayments, interestCode };
}

/** Each facility's plan: its legs for both forecasts and what the Trade finance table shows. */
async function buildTf(sb: Sb, companyId: number, a: {
  today: string; currentMonth: string; chart: Chart; master: SupplierMasterRow[]; nowBills: DueBill[];
  /** The draws owed as at this day: today for the Cash Flow; the start for the Forecast Balance Sheet. */
  openAsOf: string;
  grid: ForecastGrid; suppliers: SupplierGrid; accounts: ForecastAccount[];
}): Promise<{ ok: true; facilities: TfFacilityPayload[]; legs: CashLeg[]; interestCodes: Set<string> } | Fail> {
  if (a.chart.facilities.length === 0) return { ok: true, facilities: [], legs: [], interestCodes: new Set() };
  const codes = a.chart.facilities.map((f) => f.code);
  const [books, plans] = await Promise.all([
    loadFacilityBooks(sb, companyId, codes, a.chart.money, a.today),
    sb.from('acc_tf_plans').select('account_code, tenor_days, rate_bp, suppliers, off').eq('company_id', companyId),
  ]);
  if (!books.ok) return books;
  if (plans.error) return { ok: false, reason: `trade finance plans: ${failed(plans.error)}` };
  const planOf = new Map(((plans.data ?? []) as Array<{ account_code: string; tenor_days: number | null; rate_bp: number | null; suppliers: unknown; off: unknown }>).map((p) => [p.account_code, p]));
  const byId = new Map(a.master.map((s) => [String(s.id), s]));
  const byCode = new Map(a.master.map((s) => [String(s.code), s]));
  const termMonths = (id: string): number => parseTermMonths(byId.get(id)?.payment_terms ?? null).months;
  const shown = shownMonths(a.currentMonth);
  const lastYm = shown[shown.length - 1] ?? a.currentMonth;
  /* What each supplier is due: the bills the books owe, then the Forecast P&L's supplier figures from this month on. */
  const billDues = a.nowBills.flatMap((b) => {
    const s = b.supplierCode == null ? undefined : byCode.get(b.supplierCode);
    return s ? [{ supplierId: String(s.id), ym: billMonth(b).ym, sen: b.sen }] : [];
  });
  const forecastDues = Object.keys(a.grid).filter((S) => S >= a.currentMonth).flatMap((S) =>
    monthFigures(a.grid[S] ?? {}, a.suppliers[S] ?? {}, a.accounts).lines.flatMap((l) => (l.keyed === 'suppliers'
      ? l.bySupplier.filter((x) => x.supplierId !== OTHER_SUPPLIER).map((x) => ({ supplierId: x.supplierId, ym: addMonthsYm(S, termMonths(x.supplierId)), sen: x.amountSen }))
      : [])));
  /* Every supplier's dues, so the table can show one the moment Finance adds it; the plan draws the chosen ones'. */
  const everyone = new Set([...billDues, ...forecastDues].map((d) => d.supplierId));
  const allDues = supplierDues({ currentYm: a.currentMonth, lastYm, chosen: everyone, bills: billDues, forecast: forecastDues });
  const facilities: TfFacilityPayload[] = [];
  const legs: CashLeg[] = [];
  const interestCodes = new Set<string>();
  for (const f of a.chart.facilities) {
    const plan = planOf.get(f.code);
    const tenorSet = plan?.tenor_days ?? null;
    const rateSet = plan?.rate_bp ?? null;
    const defaultRate = defaultRateBp(books.repayments.get(f.code) ?? []);
    const tenorDays = tenorSet ?? DEFAULT_TENOR_DAYS;
    const rateBp = rateSet ?? defaultRate;
    const ic = books.interestCode.get(f.code);
    const interest = ic ? { code: ic, name: a.chart.names.get(ic) ?? ic } : null;
    if (interest) interestCodes.add(interest.code);
    const open = openDraws((books.lines.get(f.code) ?? []).filter((l) => l.date <= a.openAsOf));
    const chosen = ids(plan?.suppliers).filter((id) => byId.has(id));
    const off = offOf(plan?.off);
    const dues: Dues = Object.fromEntries(chosen.flatMap((id) => { const found = (allDues as Partial<Dues>)[id]; return found ? [[id, found]] : []; }));
    const built = tfPlan({ currentYm: a.currentMonth, facility: f, interest, tenorDays, rateBp, open, dues, off, supplierName: (id) => String(byId.get(id)?.name ?? id) }, shown);
    legs.push(...built.legs);
    facilities.push({
      ...f, tenorSet, rateSet, tenorDays, rateBp, defaultRateBp: defaultRate, interest,
      owedNowSen: open.reduce((s, d) => s + d.sen, 0), open, suppliers: chosen, off, dues: allDues, schedule: built.schedule,
    });
  }
  return { ok: true, facilities, legs, interestCodes };
}

type Resolved = Extract<Awaited<ReturnType<typeof resolveLayout>>, { ok: true }>;
/** What both forecasts stand on: the Forecast P&L as cash legs, the keyed table, the company's chart, suppliers and roles. */
type Basis = {
  win: { from: string; to: string }; accounts: ForecastAccount[]; grid: ForecastGrid; suppliers: SupplierGrid;
  rpLayout: Resolved; pnlLayout: Resolved; roles: Awaited<ReturnType<typeof resolveRoles>>; master: SupplierMasterRow[];
  receiptMix: ReceiptMix; chart: Chart; byId: Map<string, SupplierMasterRow>; byCode: Map<string, SupplierMasterRow>;
  flaggedIds: Set<string>; salaryCodes: Set<string>; built: ReturnType<typeof buildPnlCashLegs>; nameOf: (code: string) => string;
  inputLegs: CashLeg[]; currentMonth: string; controls: string[]; supplierTermOf: (code: string | null) => TermInfo; purchaseCodes: Set<string>;
};

async function forecastBasis(sb: Sb, companyId: number, layoutIds: number[], today: string): Promise<({ ok: true } & Basis) | Fail> {
  const win = measuredWindow(today);
  const [accs, grid, rpLayout, pnlLayout, roles, master, bills, receipts, chart, inputs] = await Promise.all([
    loadForecastAccounts(sb, companyId),
    loadGrid(sb, companyId),
    resolveLayout(sb, layoutIds, 'rp'),
    resolveLayout(sb, layoutIds, 'pnl'),
    resolveRoles(sb, companyId),
    loadSupplierMaster(sb, companyId),
    loadSupplierBills(sb, companyId, win.from, win.to),
    loadReceiptMix(sb, companyId, win),
    loadChartLeaves(sb, companyId),
    loadForecastInputs(sb, companyId),
  ]);
  if (!accs.ok) return { ok: false, reason: `forecast accounts: ${accs.reason}` };
  if (!grid.ok) return { ok: false, reason: `forecast: ${grid.reason}` };
  if (!rpLayout.ok) return { ok: false, reason: rpLayout.reason };
  if (!pnlLayout.ok) return { ok: false, reason: pnlLayout.reason };
  if (!master.ok) return { ok: false, reason: master.reason };
  if (!bills.ok) return { ok: false, reason: bills.reason };
  if (!receipts.ok) return { ok: false, reason: receipts.reason };
  if (!chart.ok) return { ok: false, reason: chart.reason };
  if (!inputs.ok) return { ok: false, reason: inputs.reason };

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
  /* The Capex & financing table's amounts, on their own accounts in their own months. */
  const nameOf = (code: string): string => chart.names.get(code) ?? code;
  const inputLegs = keyedInputLegs(inputs.months, nameOf);
  const currentMonth = today.slice(0, 7);
  const controls = [roles.AP, roles.AP_OTHER].filter((c) => c !== '');
  const supplierTermOf = (code: string | null): TermInfo => termOf(code == null ? undefined : byCode.get(code));
  return {
    ok: true, win, accounts: accs.accounts, grid: grid.grid, suppliers: grid.suppliers, rpLayout, pnlLayout, roles, master: master.rows,
    receiptMix: receipts.mix, chart, byId, byCode, flaggedIds, salaryCodes, built, nameOf, inputLegs, currentMonth, controls, supplierTermOf,
    purchaseCodes: new Set(accs.accounts.filter(isPurchaseAccount).map((a) => a.code)),
  };
}

export async function buildCashFlowForecast(sb: Sb, companyId: number, layoutIds: number[], from: string, to: string, today: string): Promise<{ ok: true; payload: CashFlowForecastPayload } | Fail> {
  const b = await forecastBasis(sb, companyId, layoutIds, today);
  if (!b.ok) return b;
  const { win, roles, master, chart, byId, flaggedIds, built, nameOf, inputLegs, currentMonth, controls, supplierTermOf, rpLayout, purchaseCodes } = b;
  const accs = { accounts: b.accounts };
  const grid = { grid: b.grid, suppliers: b.suppliers };
  const receipts = { mix: b.receiptMix };
  const tree = blockOf(rpLayout.layout.blocks, 'accounts');

  /* From the current month on: the orders and bills in hand, and the trade-finance plan, which
     pays its interest with each repayment — so the Forecast P&L's own line for it steps aside. */
  let facts: DocsFacts | null = null;
  let tf: { facilities: TfFacilityPayload[]; legs: CashLeg[]; interestCodes: Set<string> } = { facilities: [], legs: [], interestCodes: new Set() };
  if (to >= currentMonth) {
    const got = await loadDocsFacts(sb, companyId, { today, currentMonth, controls, nameOf, termOf: supplierTermOf });
    if (!got.ok) return got;
    facts = got;
    const t = await buildTf(sb, companyId, { today, openAsOf: today, currentMonth, chart, master, nowBills: got.now, grid: grid.grid, suppliers: grid.suppliers, accounts: accs.accounts });
    if (!t.ok) return t;
    tf = t;
  }
  const pnlLegs = built.legs.filter((l) => !tf.interestCodes.has(l.code));
  const interestLeftOut = [...new Set(built.legs.filter((l) => tf.interestCodes.has(l.code)).map((l) => l.code))].map((code) => ({ code, name: nameOf(code) }));
  const legs = [...pnlLegs, ...inputLegs, ...tf.legs];
  const months = forecastMonths(from, to, currentMonth, legs).map(({ month, future }) => ({
    month, future, report: forecastMonthReport(month, legs.filter((l) => l.ym === month), tree, rpLayout.stored, companyId, PNL_COLUMN_NAME),
  }));
  /* Orders & bills: sales and purchases come from the open orders and the owed bills, so of
     the Forecast P&L only its other lines join them. */
  const docs = facts == null ? null : docsColumn(companyId, facts, {
    currentMonth, ar: roles.AR, ap: roles.AP, nameOf, tree, stored: rpLayout.stored,
    costs: pnlLegs.filter((l) => l.group == null && !purchaseCodes.has(l.code)),
    inputs: [...inputLegs, ...tf.legs],
  });
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
      docs,
      tf: tf.facilities.length === 0 ? null : {
        facilities: tf.facilities.map((f) => ({
          code: f.code, lender: f.lender, tenorDays: f.tenorDays, rateBp: f.rateBp, owedNowSen: f.owedNowSen,
          suppliers: f.suppliers.map((id) => String(byId.get(id)?.name ?? id)),
        })),
        interestLeftOut,
      },
    },
  };
}

/* ── The door, with its 60-second memory (the Dashboard's) ──────────────── */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;
const cache = new Map<string, { at: number; payload: CashFlowForecastPayload }>();
const bsCache = new Map<string, { at: number; payload: BsForecastPayload }>();
/** For the tests. */
export const clearCashFlowForecastCache = (): void => { cache.clear(); bsCache.clear(); };
/** A company's answers, after its Capex & financing table or trade-finance plan changed. */
const forgetCompany = (companyId: number): void => {
  for (const m of [cache, bsCache] as Array<Map<string, unknown>>) for (const key of [...m.keys()]) if (key.startsWith(`${companyId}|`)) m.delete(key);
};

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


/* ── The Capex & financing table (step 3) ─────────────────────────────────── */

export type ForecastInputsPayload = {
  currentMonth: string;
  /** The months the table shows: the current one and the eleven after it. */
  shown: string[];
  months: KeyedInputs;
  accounts: KeyableAccount[];
  /** Accounts keyed in some month that the layout no longer offers: to be cleared before a save. */
  notOffered: Array<{ code: string; name: string }>;
};

const shownMonths = (current: string): string[] => {
  const out: string[] = [];
  let [y, m] = current.split('-').map(Number) as [number, number];
  for (let i = 0; i < KEYED_MONTHS; i += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
};

/** The accounts on offer for the active company: its layout's funding block over its own chart. */
async function loadOffered(sb: Sb, companyId: number, layoutIds: number[]): Promise<{ ok: true; accounts: KeyableAccount[]; names: Map<string, string> } | Fail> {
  const [laid, chart] = await Promise.all([resolveLayout(sb, layoutIds, 'rp'), loadChartLeaves(sb, companyId)]);
  if (!laid.ok) return { ok: false, reason: laid.reason };
  if (!chart.ok) return { ok: false, reason: chart.reason };
  return { ok: true, accounts: keyableAccounts(blockOf(laid.layout.blocks, 'accounts'), chart.names), names: chart.names };
}

export const forecastInputsGetHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const [offered, stored] = await Promise.all([loadOffered(sb, co.companyId, allowedIds(c)), loadForecastInputs(sb, co.companyId)]);
  if (!offered.ok) return c.json({ error: 'load_failed', reason: offered.reason }, 500);
  if (!stored.ok) return c.json({ error: 'load_failed', reason: stored.reason }, 500);
  const currentMonth = todayMyt().slice(0, 7);
  const payload: ForecastInputsPayload = {
    currentMonth, shown: shownMonths(currentMonth), months: stored.months, accounts: offered.accounts,
    notOffered: keyedNotOffered(stored.months, new Set(offered.accounts.map((a) => a.code))).map((code) => ({ code, name: offered.names.get(code) ?? code })),
  };
  return c.json(payload);
};

export const forecastInputsPutHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, WRITE_PERM)) return c.json(NO_WRITE, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const body = (raw !== null && typeof raw === 'object' ? raw : {}) as { months?: unknown };
  const sb = c.get('supabase');
  const [offered, stored] = await Promise.all([loadOffered(sb, co.companyId, allowedIds(c)), loadForecastInputs(sb, co.companyId)]);
  if (!offered.ok) return c.json({ error: 'load_failed', reason: offered.reason }, 500);
  if (!stored.ok) return c.json({ error: 'load_failed', reason: stored.reason }, 500);
  const checked = validateKeyedInputs(body.months, new Set(offered.accounts.map((a) => a.code)));
  if (!checked.ok) return c.json({ error: 'bad_cell', cell: checked.cell, message: `${checked.cell}: ${checked.reason}` }, 400);
  /* Kept first, then the cleared cells removed: a failure between the two leaves an extra amount, never a lost one. */
  const at = new Date().toISOString();
  const rows = Object.entries(checked.months).flatMap(([month, cells]) => Object.entries(cells).map(([code, sen]) => ({
    company_id: co.companyId, month, account_code: code, amount_sen: sen, updated_at: at, updated_by: who(c),
  })));
  if (rows.length > 0) {
    const { error } = await sb.from('acc_forecast_inputs').upsert(rows, { onConflict: 'company_id,month,account_code' });
    if (error) return c.json({ error: 'save_failed', reason: failed(error) }, 500);
  }
  const kept: Partial<Record<string, Partial<Record<string, number>>>> = checked.months;
  for (const [month, cells] of Object.entries(stored.months)) {
    const gone = Object.keys(cells).filter((code) => kept[month]?.[code] === undefined);
    if (gone.length === 0) continue;
    const { error } = await sb.from('acc_forecast_inputs').delete().eq('company_id', co.companyId).eq('month', month).in('account_code', gone);
    if (error) return c.json({ error: 'save_failed', reason: failed(error) }, 500);
  }
  forgetCompany(co.companyId);
  return c.json({ ok: true, months: checked.months });
};

/* ── The Trade finance table (step 5) ─────────────────────────────────────── */

export type TfPayload = {
  currentMonth: string;
  /** The months the table shows: the current one and the eleven after it. */
  shown: string[];
  facilities: TfFacilityPayload[];
  /** The company's suppliers to choose from, by name, with their payment term. */
  suppliers: Array<{ id: string; code: string; name: string; term: string | null }>;
};

const MAX_SUPPLIERS = 200;

/** GET: each facility's plan and what its chosen suppliers are due. */
export const tfGetHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const today = todayMyt();
  const currentMonth = today.slice(0, 7);
  const [chart, master, accs, grid, roles] = await Promise.all([
    loadChartLeaves(sb, co.companyId), loadSupplierMaster(sb, co.companyId), loadForecastAccounts(sb, co.companyId), loadGrid(sb, co.companyId), resolveRoles(sb, co.companyId),
  ]);
  if (!chart.ok) return c.json({ error: 'load_failed', reason: chart.reason }, 500);
  if (!master.ok) return c.json({ error: 'load_failed', reason: master.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  if (!grid.ok) return c.json({ error: 'load_failed', reason: grid.reason }, 500);
  const byCode = new Map(master.rows.map((s) => [String(s.code), s]));
  const nameOf = (code: string): string => chart.names.get(code) ?? code;
  let nowBills: DueBill[] = [];
  if (chart.facilities.length > 0) {
    const got = await loadNowBills(sb, co.companyId, {
      today, controls: [roles.AP, roles.AP_OTHER].filter((x) => x !== ''), nameOf,
      termOf: (code) => parseTermMonths(code == null ? null : (byCode.get(code)?.payment_terms ?? null)),
    });
    if (!got.ok) return c.json({ error: 'load_failed', reason: got.reason }, 500);
    nowBills = got.bills;
  }
  const t = await buildTf(sb, co.companyId, { today, openAsOf: today, currentMonth, chart, master: master.rows, nowBills, grid: grid.grid, suppliers: grid.suppliers, accounts: accs.accounts });
  if (!t.ok) return c.json({ error: 'load_failed', reason: t.reason }, 500);
  const payload: TfPayload = {
    currentMonth, shown: shownMonths(currentMonth), facilities: t.facilities,
    suppliers: master.rows.filter((s) => String(s.status ?? 'ACTIVE').toUpperCase() !== 'INACTIVE')
      .map((s) => ({ id: String(s.id), code: String(s.code), name: String(s.name ?? s.code), term: s.payment_terms ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
  };
  return c.json(payload);
};

type TfBody = Record<string, { tenorDays: number | null; rateBp: number | null; suppliers: string[]; off: Off }>;

/** Each facility's plan as sent, or the first thing wrong with it. */
export function validateTfPlans(raw: unknown, facilities: ReadonlySet<string>, supplierIds: ReadonlySet<string>): { ok: true; plans: TfBody } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'facilities must be a map of account code to plan.' };
  const plans: TfBody = {};
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!facilities.has(code)) return { ok: false, message: `${code}: not a trade-finance account of this company.` };
    const o = (v ?? {}) as { tenorDays?: unknown; rateBp?: unknown; suppliers?: unknown; off?: unknown };
    const whole = (x: unknown, lo: number, hi: number): number | null | undefined =>
      (x == null ? null : Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi ? (x as number) : undefined);
    const tenorDays = whole(o.tenorDays, 1, 400);
    if (tenorDays === undefined) return { ok: false, message: `${code}: the tenor is a whole number of days, 1 to 400.` };
    const rateBp = whole(o.rateBp, 0, 10_000);
    if (rateBp === undefined) return { ok: false, message: `${code}: the interest per draw is 0% to 100%.` };
    if (!Array.isArray(o.suppliers)) return { ok: false, message: `${code}: suppliers must be a list.` };
    const chosen = ids(o.suppliers);
    if (chosen.length > MAX_SUPPLIERS) return { ok: false, message: `${code}: at most ${MAX_SUPPLIERS} suppliers.` };
    const stranger = chosen.find((id) => !supplierIds.has(id));
    if (stranger) return { ok: false, message: `${code}: supplier ${stranger} is not one of this company's.` };
    const off = offOf(o.off);
    for (const [ym, list] of Object.entries(off)) off[ym] = list.filter((id) => chosen.includes(id));
    plans[code] = { tenorDays, rateBp, suppliers: chosen, off: Object.fromEntries(Object.entries(off).filter(([, list]) => list.length > 0)) };
  }
  return { ok: true, plans };
}

/** PUT { facilities }: each facility sent is kept as sent. */
export const tfPutHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, WRITE_PERM)) return c.json(NO_WRITE, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: { facilities?: unknown } | null = null;
  try { body = (await c.req.json()) as { facilities?: unknown } | null; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const [chart, master] = await Promise.all([loadChartLeaves(sb, co.companyId), loadSupplierMaster(sb, co.companyId)]);
  if (!chart.ok) return c.json({ error: 'load_failed', reason: chart.reason }, 500);
  if (!master.ok) return c.json({ error: 'load_failed', reason: master.reason }, 500);
  const checked = validateTfPlans(body?.facilities, new Set(chart.facilities.map((f) => f.code)), new Set(master.rows.map((s) => String(s.id))));
  if (!checked.ok) return c.json({ error: 'bad_plan', message: checked.message }, 400);
  const rows = Object.entries(checked.plans).map(([code, p]) => ({
    company_id: co.companyId, account_code: code, tenor_days: p.tenorDays, rate_bp: p.rateBp, suppliers: p.suppliers, off: p.off,
    updated_at: new Date().toISOString(), updated_by: who(c),
  }));
  if (rows.length > 0) {
    const { error } = await sb.from('acc_tf_plans').upsert(rows, { onConflict: 'company_id,account_code' });
    if (error) return c.json({ error: 'save_failed', reason: failed(error) }, 500);
  }
  forgetCompany(co.companyId);
  return c.json({ ok: true });
};

/* ── The Forecast Balance Sheet (step 6) ──────────────────────────────────── */

export type BsForecastPayload = {
  /** The last month-end: the actual sheet the forecast starts from. */
  start: string;
  currentMonth: string;
  /** From the current month to the last the Forecast P&L has figures for, a year at most. */
  months: Array<{ month: string; report: BalanceSheetReport }>;
  /** The salary accrual the forecast moves, when the chart has one. */
  accrual: { code: string; name: string } | null;
  /** The open orders' balances at the start, and what of them was counted: never beyond the debtors on the start sheet. */
  receipts: { orders: number; sen: number; capSen: number; countedSen: number };
};

const SALARY_ACCRUAL = /ACCRU\w*\W*SALAR/i;
const STOCK_LINE = /\bSTOCKS?\b/i;
const ACCUMULATED = /ACCUM/i;

export async function buildBalanceSheetForecast(sb: Sb, companyId: number, layoutIds: number[], today: string): Promise<{ ok: true; payload: BsForecastPayload } | Fail> {
  const b = await forecastBasis(sb, companyId, layoutIds, today);
  if (!b.ok) return b;
  const { currentMonth, chart, roles } = b;
  const start = monthEnd(addMonthsYm(currentMonth, -1));
  const src = dbSources(sb, companyId, layoutIds);
  const [sheet, laid, facts] = await Promise.all([
    buildBalanceSheet(src, companyId, start),
    src.layout('balance_sheet'),
    loadDocsFacts(sb, companyId, { today, currentMonth, controls: b.controls, nameOf: b.nameOf, termOf: b.supplierTermOf }),
  ]);
  if (!sheet.ok) return { ok: false, reason: `balance sheet: ${sheet.reason}` };
  if (!laid.ok) return { ok: false, reason: laid.reason };
  if (!facts.ok) return facts;
  const tf = await buildTf(sb, companyId, { today, openAsOf: start, currentMonth, chart, master: b.master, nowBills: facts.now, grid: b.grid, suppliers: b.suppliers, accounts: b.accounts });
  if (!tf.ok) return tf;

  /* The months: from this one to the last the Forecast P&L has figures for, a year at most. */
  const lastFigure = Object.keys(b.grid).sort().at(-1) ?? '';
  const cap = addMonthsYm(currentMonth, KEYED_MONTHS - 1);
  const months: string[] = [];
  for (let ym = currentMonth; ym <= lastFigure && ym <= cap; ym = addMonthsYm(ym, 1)) months.push(ym);

  const accrualLine = sheet.report.liabilities.find((l) => SALARY_ACCRUAL.test(l.name));
  const accrualCode = accrualLine?.code ?? [...chart.kinds].find(([, k]) => k.type === 'LIABILITY' && SALARY_ACCRUAL.test(k.name))?.[0] ?? null;
  const byCodeAcc = new Map(b.accounts.map((a) => [a.code, a]));
  const isPurchase = (code: string): boolean => b.purchaseCodes.has(code) && blockOfSection(byCodeAcc.get(code)?.section ?? '') === 'costOfSales';
  /* What each month earns and spends before money moves. */
  const accruals: Record<string, Accrual> = {};
  for (const ym of months) {
    const f = monthFigures(b.grid[ym] ?? {}, b.suppliers[ym] ?? {}, b.accounts);
    const a: Accrual = { salesSen: f.salesSen, purchasesSen: 0, salariesSen: 0, depnSen: 0 };
    for (const l of f.lines) {
      if (l.block === 'tradingIncome' || l.amountSen === 0 || tf.interestCodes.has(l.code)) continue;
      if (isPurchase(l.code)) a.purchasesSen += l.amountSen;
      else if (accrualCode && l.block === 'expenses' && b.salaryCodes.has(l.code)) a.salariesSen += l.amountSen;
      else if (isNonCashName(l.name) && !STOCK_LINE.test(l.name)) a.depnSen += l.amountSen;
    }
    accruals[ym] = a;
  }
  /* The money, as the P&L forecast moves it (its own months from this one on), the plan and the table. */
  const moves: BsMove[] = [];
  const facilities = new Set(chart.facilities.map((x) => x.code));
  for (const l of b.built.legs) {
    if (l.fromYm < currentMonth || tf.interestCodes.has(l.code)) continue;
    if (l.group) { moves.push({ ym: l.ym, sen: l.sen, against: roles.AR, flow: 'in' }); continue; }
    if (isPurchase(l.code)) { moves.push({ ym: l.ym, sen: l.sen, against: roles.AP, flow: 'out' }); continue; }
    if (accrualCode && b.salaryCodes.has(l.code)) continue;
    moves.push({ ym: l.ym, sen: l.sen, against: FC_PROFIT, flow: l.flow });
  }
  for (const l of b.inputLegs) moves.push({ ym: l.ym, sen: l.sen, against: l.code, flow: l.flow });
  for (const l of tf.legs) moves.push({ ym: l.ym, sen: l.sen, against: facilities.has(l.code) ? l.code : FC_PROFIT, flow: l.flow });

  /* What was open at the start. */
  const arOnSheet = sheet.report.assets.filter((l) => l.code === roles.AR).reduce((s, l) => s + l.amountSen, 0);
  const due = facts.orders.baseline.flatMap((o) => (o.deliveryDate ? [{ ym: o.deliveryDate.slice(0, 7), sen: o.balanceSen }] : []));
  const openingReceipts = capReceipts(due, arOnSheet);
  const deltas = bsDeltas({
    months, accounts: { ar: roles.AR, ap: roles.AP, accrual: accrualCode },
    accruals, moves,
    openingBills: facts.then.map((x) => ({ ym: billMonth(x).ym, sen: x.sen })),
    openingReceipts,
    openingSalarySen: accrualLine ? Math.max(0, accrualLine.amountSen) : 0,
  });
  const running = cumulate(months, deltas);

  /* Each month as the Balance Sheet's own shape, on its own layout. */
  const lineOf = (side: StartSheet['assets']) => side.map((l) => ({ ...l }));
  const startSheet: StartSheet = {
    assets: lineOf(sheet.report.assets), liabilities: lineOf(sheet.report.liabilities), equity: lineOf(sheet.report.equity), earningsSen: sheet.report.totals.earningsSen,
  };
  const anchorFrom = (ls: StartSheet['assets'], pick: (l: StartSheet['assets'][number]) => boolean) => {
    const l = ls.filter(pick).sort((x, y) => x.code.localeCompare(y.code)).at(0);
    return l ? { code: l.code, section: l.section } : null;
  };
  const anchors = {
    cash: anchorFrom(startSheet.assets, (l) => chart.money.has(l.code)),
    depn: anchorFrom(startSheet.assets, (l) => ACCUMULATED.test(l.name)) ?? anchorFrom(startSheet.assets, (l) => /FIXED/i.test(l.section)),
  };
  const chartOf = (code: string): { name: string; side: Side; section: string } | null => {
    const k = chart.kinds.get(code);
    if (!k) return null;
    const side: Side = k.type === 'LIABILITY' ? 'liabilities' : k.type === 'EQUITY' ? 'equity' : 'assets';
    return { name: k.name, side, section: k.section ?? (side === 'assets' ? 'CURRENT ASSETS' : side === 'liabilities' ? 'CURRENT LIABILITIES' : 'CAPITAL') };
  };
  const report = (ym: string): BalanceSheetReport => {
    const f = forecastSheet(startSheet, running[ym] ?? {}, chartOf, anchors);
    const sum = (ls: StartSheet['assets']): number => ls.reduce((s, l) => s + l.amountSen, 0);
    const assetsSen = sum(f.assets);
    const liabilitiesSen = sum(f.liabilities);
    const equitySen = sum(f.equity);
    const baseSen = assetsSen !== 0 ? assetsSen : null;
    const onTree = (block: string, ls: StartSheet['assets']): LaidNode[] => layOutBlock(blockOf(laid.layout.blocks, block), ls, companyId, baseSen);
    return {
      asOf: monthEnd(ym), assets: f.assets, liabilities: f.liabilities, equity: f.equity,
      stock: sheet.report.stock,
      layout: { stored: laid.stored, baseSen, assets: onTree('assets', f.assets), liabilities: onTree('liabilities', f.liabilities), equity: onTree('equity', f.equity) },
      totals: { assetsSen, liabilitiesSen, equitySen, earningsSen: f.earningsSen, checkSen: assetsSen - liabilitiesSen - equitySen - f.earningsSen },
    };
  };
  return {
    ok: true,
    payload: {
      start, currentMonth,
      months: months.map((month) => ({ month, report: report(month) })),
      accrual: accrualCode ? { code: accrualCode, name: b.nameOf(accrualCode) } : null,
      receipts: {
        orders: due.length, sen: due.reduce((s, d) => s + d.sen, 0), capSen: Math.max(0, arOnSheet),
        countedSen: openingReceipts.reduce((s, r) => s + r.sen, 0),
      },
    },
  };
}

/** GET /accounting/reports/balance-sheet-forecast — the statements' read key; the Worker keeps an answer 60 s. */
export const balanceSheetForecastHandler = async (c: Ctx): Promise<Response> => {
  if (!hasHouzsPerm(c, READ_PERM)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const ids = allowedIds(c);
  const today = todayMyt();
  const key = [co.companyId, 'bs', ids.join('.'), today].join('|');
  const hit = bsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return c.json({ ...hit.payload, cached: true });
  const r = await buildBalanceSheetForecast(c.get('supabase'), co.companyId, ids, today);
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  if (bsCache.size >= CACHE_MAX) bsCache.delete(bsCache.keys().next().value as string);
  bsCache.set(key, { at: Date.now(), payload: r.payload });
  return c.json(r.payload);
};
