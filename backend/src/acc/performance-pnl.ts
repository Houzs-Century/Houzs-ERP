// ----------------------------------------------------------------------------
// performance-pnl — the Performance P&L (owner 2026-09-12: 我还要多一份
// performance P&L，就是 sales 和 COGS 的数额是根据 sales order 的，expense 其他
// remain，但是 expense 的 operating 要根据 sales 的 16% 来算 … 按 SO 日期 … 未送货
// 也算，因为我是看当月的表现 … 分成 bedframe, mattress, sofa, dining, accessory,
// service/Transport income … 根据 SO 明显的成本 … operating expense 根据 total
// sales exclude transport 的 amount，16% 要设计成可调 … 只取代 900-O001，然后在
// performance P&L 要注明; docs/bugs/0835).
//
// TWO SOURCES, deliberately, and the report says so on its face:
//   • the SALES side is the sales orders dated in the period — every status
//     except DRAFT and CANCELLED, delivered or not (当月的表现) — sales and
//     cost of sales per line as the order records them (total_sen; unit cost
//     × quantity, which is line_cost_sen), grouped BEDFRAME / MATTRESS / SOFA /
//     DINING / ACCESSORY / SERVICE (transport income); a line outside the six
//     lands under OTHERS so the total still ties to the orders;
//   • the EXPENSE side is the ledger by journal date — every EXPENSES-section
//     account as booked — except ONE: the operating-expense account the
//     company names (900-O001 by default), which is REPLACED by a rate (16%
//     by default, adjustable) of sales excluding service, because the owner
//     budgets operating cost as a share of goods sold.
// The rate and the account live on scm.acc_company_settings; the figures are
// computed live on every read and stored nowhere. The building is pure
// (buildPerformanceReport) so the contract test feeds it worlds directly.
// ----------------------------------------------------------------------------

import { isDeliveryFeeServiceCode, isServiceLine } from '../scm/shared/service-sku';
import { SO_DELIVERED_OR_BEYOND, SO_NOT_AN_ORDER } from '../scm/shared/so-deliverable-states';

type Db = any;

export type PerformanceSettings = { rateBp: number; account: string };
/** 16% of sales excluding service, in place of 900-O001 — the owner's numbers (2026-09-12). */
export const DEFAULT_PERFORMANCE_SETTINGS: PerformanceSettings = { rateBp: 1600, account: '900-O001' };

/** The company's rate and account, else the owner's defaults (a company with
    no settings row yet reads the same numbers the migration defaulted). */
export async function loadPerformanceSettings(sb: Db, companyId: number): Promise<{ ok: true; settings: PerformanceSettings } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_company_settings')
    .select('performance_opex_rate_bp, performance_opex_account')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  const row = (data ?? null) as { performance_opex_rate_bp?: number | null; performance_opex_account?: string | null } | null;
  const rate = Number(row?.performance_opex_rate_bp);
  return {
    ok: true,
    settings: {
      rateBp: row?.performance_opex_rate_bp != null && Number.isFinite(rate) ? rate : DEFAULT_PERFORMANCE_SETTINGS.rateBp,
      account: String(row?.performance_opex_account ?? '').trim() || DEFAULT_PERFORMANCE_SETTINGS.account,
    },
  };
}

/** Save the pair on the company's row — the deposit-invoice switch beside it
    is left as it is (the upsert names only these columns). */
export async function savePerformanceSettings(sb: Db, companyId: number, s: PerformanceSettings, actor: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await sb.from('acc_company_settings').upsert({
    company_id: companyId,
    performance_opex_rate_bp: s.rateBp,
    performance_opex_account: s.account,
    updated_at: new Date().toISOString(),
    updated_by: actor,
  }, { onConflict: 'company_id' });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/* ── The owner's groups ──────────────────────────────────────────────────── */

export const PERFORMANCE_GROUPS = [
  { key: 'bedframe', label: 'Bedframe' },
  { key: 'mattress', label: 'Mattress' },
  { key: 'sofa', label: 'Sofa' },
  { key: 'dining', label: 'Dining' },
  { key: 'accessory', label: 'Accessory' },
  { key: 'service', label: 'Service / transport income' },
  { key: 'others', label: 'Others' },
] as const;
export type PerformanceGroupKey = (typeof PERFORMANCE_GROUPS)[number]['key'];

/** Which of the owner's six a line belongs to: SERVICE by any signal (the
    group, the SVC- code), then the group word the SKU's category wrote on
    the line; a line outside the six is OTHERS, never dropped. */
export function performanceGroupOf(line: { item_group: string | null; item_code: string | null }): PerformanceGroupKey {
  if (isServiceLine({ itemGroup: line.item_group, itemCode: line.item_code })) return 'service';
  const g = String(line.item_group ?? '').toLowerCase();
  if (g.includes('mattress')) return 'mattress';
  if (g.includes('sofa')) return 'sofa';
  if (g.includes('bedframe')) return 'bedframe';
  if (g.includes('dining')) return 'dining';
  if (g.includes('accessor')) return 'accessory';
  return 'others';
}

/* ── The report ──────────────────────────────────────────────────────────── */

export type PerfOrder = { doc_no: string; so_date: string; status: string; delivery_fee_sen: number | null };
export type PerfLine = {
  doc_no: string; item_group: string | null; item_code: string | null; qty: number | null;
  total_sen: number | null; unit_cost_sen: number | null; line_cost_sen: number | null; cancelled: boolean | null;
};
/** An EXPENSES-section account's live debit for the period, as the ledger booked it. */
export type PerfExpense = { code: string; name: string; amountSen: number };

export type PerformanceGroup = { key: PerformanceGroupKey; label: string; lines: number; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null };
export type PerformanceReport = {
  from: string; to: string;
  orders: { counted: number; notDelivered: number; excludedDraft: number; excludedCancelled: number };
  /** The six, in the owner's order, then OTHERS only when a line landed there. */
  groups: PerformanceGroup[];
  totals: { salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null; salesExServiceSen: number };
  operatingExpense: {
    rateBp: number; baseSen: number; amountSen: number;
    account: string; accountName: string | null; accountFound: boolean;
    /** What the ledger booked on that account in the period — shown, left out of the expenses. */
    bookedSen: number;
  };
  /** Every other EXPENSES-section account as booked, by code. */
  otherExpenses: PerfExpense[];
  otherExpensesSen: number;
  netSen: number; netPct: number | null;
  settings: PerformanceSettings;
};

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function buildPerformanceReport(p: {
  from: string; to: string;
  orders: PerfOrder[]; lines: PerfLine[]; expenses: PerfExpense[];
  settings: PerformanceSettings;
  /** The named account as the chart has it, or null when the chart does not. */
  account: { code: string; name: string } | null;
}): PerformanceReport {
  const excludedDraft = p.orders.filter((o) => String(o.status) === 'DRAFT').length;
  const excludedCancelled = p.orders.filter((o) => String(o.status) === 'CANCELLED').length;
  const live = p.orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status)));
  const liveDocs = new Set(live.map((o) => o.doc_no));

  const at = new Map<PerformanceGroupKey, { lines: number; salesSen: number; cogsSen: number }>(
    PERFORMANCE_GROUPS.map((g) => [g.key, { lines: 0, salesSen: 0, cogsSen: 0 }]),
  );
  const hasFeeLine = new Set<string>();
  for (const l of p.lines) {
    if (!liveDocs.has(l.doc_no) || l.cancelled === true) continue;
    const a = at.get(performanceGroupOf(l))!;
    /* The order's own cost: unit cost × quantity, written on the line when
       it was priced; recomputed from the parts only when the line predates
       the column. */
    const cost = l.line_cost_sen != null ? Number(l.line_cost_sen) : Math.round(Number(l.qty ?? 0) * Number(l.unit_cost_sen ?? 0));
    a.lines += 1;
    a.salesSen += Number(l.total_sen ?? 0);
    a.cogsSen += cost;
    if (isDeliveryFeeServiceCode(l.item_code)) hasFeeLine.add(l.doc_no);
  }
  /* A legacy order whose delivery fee sits only on its header (no
     SVC-DELIVERY line): the fee is service income the lines do not carry —
     the same rule the order's own totals follow. */
  for (const o of live) {
    if (!hasFeeLine.has(o.doc_no) && Number(o.delivery_fee_sen ?? 0) > 0) at.get('service')!.salesSen += Number(o.delivery_fee_sen);
  }

  const groups: PerformanceGroup[] = PERFORMANCE_GROUPS
    .map((g) => {
      const a = at.get(g.key)!;
      return { key: g.key, label: g.label, lines: a.lines, salesSen: a.salesSen, cogsSen: a.cogsSen, gpSen: a.salesSen - a.cogsSen, gpPct: pct(a.salesSen - a.cogsSen, a.salesSen) };
    })
    .filter((g) => g.key !== 'others' || g.lines > 0 || g.salesSen !== 0 || g.cogsSen !== 0);

  const salesSen = groups.reduce((s, g) => s + g.salesSen, 0);
  const cogsSen = groups.reduce((s, g) => s + g.cogsSen, 0);
  const gpSen = salesSen - cogsSen;
  const serviceSalesSen = at.get('service')!.salesSen;
  const salesExServiceSen = salesSen - serviceSalesSen;

  const opexSen = Math.round((salesExServiceSen * p.settings.rateBp) / 10000);
  const code = p.settings.account;
  const replaced = p.expenses.find((e) => e.code === code) ?? null;
  const accountFound = p.account != null;
  /* Only the named account is replaced — and only when the chart carries
     it; a code the chart does not know replaces nothing, and the report
     says so rather than quietly dropping a booked expense. */
  const otherExpenses = (accountFound ? p.expenses.filter((e) => e.code !== code) : p.expenses)
    .filter((e) => e.amountSen !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const otherExpensesSen = otherExpenses.reduce((s, e) => s + e.amountSen, 0);
  const netSen = gpSen - opexSen - otherExpensesSen;

  return {
    from: p.from, to: p.to,
    orders: {
      counted: live.length,
      notDelivered: live.filter((o) => !SO_DELIVERED_OR_BEYOND.has(String(o.status))).length,
      excludedDraft, excludedCancelled,
    },
    groups,
    totals: { salesSen, cogsSen, gpSen, gpPct: pct(gpSen, salesSen), salesExServiceSen },
    operatingExpense: {
      rateBp: p.settings.rateBp, baseSen: salesExServiceSen, amountSen: opexSen,
      account: code, accountName: p.account?.name ?? null, accountFound,
      bookedSen: accountFound ? (replaced?.amountSen ?? 0) : 0,
    },
    otherExpenses, otherExpensesSen,
    netSen, netPct: pct(netSen, salesSen),
    settings: p.settings,
  };
}
