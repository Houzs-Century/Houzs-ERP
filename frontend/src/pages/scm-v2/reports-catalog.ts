// ----------------------------------------------------------------------------
// reports-catalog — the Finance report list (the owner's Claude Design,
// batch 6 §4.1): every report, the group it sits under, its address and who
// sees it, in the design's order. ONE home: the report list (reports/ReportRail)
// reads it, and so does the sidebar's one Reports entry (batch 6 §1.1,
// REPORT_NAV_MEMBERS) — a second copy of these names would be a second
// decision. How the list draws a report (its icon, its one-line description)
// is reports/reportListLook, kept out of here because the sidebar — and so this
// file — is in the app's first download.
//
// A report's name is the Accounting tab's own title where it is a tab
// (accounting-tabs ACCOUNTING_TAB_TITLES), so the list, the header and the
// workspace tab can never name it three ways.
//
// WHO SEES WHICH REPORT is the gate its sidebar entry had, unchanged, kept here
// per report (`gate`): the sidebar's Reports entry is built from this list, its
// members hidden, and it shows when any member passes. The report list shows a
// report where the sidebar would show its entry (`navTo`, through makeNavFilter,
// so the Finance group's own gate still applies). Journal entries, the General
// ledger and the Trial balance keep their Books entries' gates.
//
// THE P&Ls ARE ONE ENTRY (owner 2026-11-25: 几份P&L, 可以combine 起来 … 我在这里
// 选): the list shows them as P&L, and a picker across the top of each opens the
// others — a category, Actual (by sales invoice: the books) | Performance (by
// sales order) | Forecast, then Overall | Department (PNL_CHOICES; his three
// categories, settled the same day). Each stays a report of its own here — its
// address, its gate, its method and data — so old links land where they did and
// a reader is offered only the P&Ls they may open. Logistics cost (by DO) and the
// Product changes P&L are entries of their own (「现有的logistics by DO的放side
// bar 先」).
// ----------------------------------------------------------------------------

import type { LucideIcon } from 'lucide-react';
import { BarChart3 } from 'lucide-react';
import { ACCOUNTING_TAB_TITLES, type AccountingTab } from './accounting-tabs';

export type ReportGroupId = 'statements' | 'owes' | 'sales' | 'events' | 'cards' | 'plan' | 'books' | 'audit';

export type ReportId =
  | 'pnl' | 'departments' | 'bs' | 'rp' | 'tb'
  | 'ar' | 'ap'
  | 'collection' | 'fair' | 'performance' | 'products' | 'changes' | 'changesum' | 'sotodo'
  | 'events' | 'commission' | 'logistics'
  | 'charges'
  | 'forecast' | 'dashboard'
  | 'je' | 'gl'
  | 'corrections';

export type ReportItem = {
  id: ReportId;
  /** The report's name in the list, and its header's unless `title` says otherwise. */
  label: string;
  /** The header's title where the list's name says more (Sales report · fairs). */
  title?: string;
  group: ReportGroupId;
  /** Where it opens: the page, and the Accounting tab when it is one. */
  path: string;
  tab?: AccountingTab;
  /** Journal entries, General ledger and Trial balance are Books pages; opened
   *  from the list they carry `in=reports`, so the list and its header follow. */
  inReports?: boolean;
  /** The sidebar entry whose gate decides who sees this report: the Reports
   *  entry's member for a report with a `gate`, the Books entry for the rest. */
  navTo: string;
  /** Who sees it — the gate its own sidebar entry had (batch 6 §1.1: "keep
   *  every member's own gate"). Absent on the Books pages, gated in Books. */
  gate?: ReportGate;
};

/** A sidebar entry's gate fields (components/Sidebar NavTab), as the reports keep them. */
export type ReportGate = {
  anyPerm: string[];
  anyAccess: string[];
  /** The Sales report's cohort: management and the Sales Director only. */
  requireFairReport?: boolean;
};

const REPORTS_GATE: ReportGate = { anyPerm: ['*', 'scm.access'], anyAccess: ['scm.finance.reports'] };
const FORECAST_GATE: ReportGate = { anyPerm: ['*', 'scm.access', 'scm.payment_voucher.post'], anyAccess: ['scm.finance.forecast'] };
const SALES_REPORT_GATE: ReportGate = {
  requireFairReport: true,
  anyPerm: ['*', 'scm.access'],
  anyAccess: ['scm.finance', 'scm.finance.reports', 'scm.finance.outstanding', 'projects.finances'],
};

export const REPORT_GROUPS: ReadonlyArray<{ id: ReportGroupId; label: string }> = [
  { id: 'statements', label: 'Statements' },
  { id: 'owes', label: 'Who owes whom' },
  { id: 'sales', label: 'Sales & collection' },
  { id: 'events', label: 'Events & logistics' },
  { id: 'cards', label: 'Card money' },
  { id: 'plan', label: 'Plan' },
  { id: 'books', label: 'Books' },
  { id: 'audit', label: 'Audit' },
];

const ACCOUNTING = '/scm/accounting';
const tabItem = (tab: AccountingTab & ReportId, group: ReportGroupId, books = false): ReportItem => ({
  id: tab,
  label: ACCOUNTING_TAB_TITLES[tab],
  group,
  path: ACCOUNTING,
  tab,
  ...(books ? { inReports: true } : { gate: REPORTS_GATE }),
  navTo: `${ACCOUNTING}?tab=${tab}`,
});

/** Every report, in the design's order (the list draws them group by group). */
export const REPORT_CATALOG: readonly ReportItem[] = [
  // The P&Ls — the list's one P&L entry, each with its own method and data (owner 2026-11-25: 我会有很多个不同的
  // p&L, 每个的算法和提取的资料不一样). The books' P&L.
  tabItem('pnl', 'statements'),
  // The month's orders per group against a budgeted operating expense (owner 2026-09-12; docs/bugs/0835).
  tabItem('performance', 'statements'),
  // Each department by its own P&L, on the invoices or on the orders (`dbasis`; owner 2026-11-19, 2026-11-25).
  tabItem('departments', 'statements'),
  // The Forecast P&L (owner 2026-09-21: the Hookka Forecast P&L, trading edition — a target per account on the
  // P&L's own tree; the Dashboard reads them beside the actuals).
  { id: 'forecast', label: 'Forecast P&L', group: 'statements', path: '/scm/forecast', navTo: '/scm/forecast', gate: FORECAST_GATE },
  tabItem('bs', 'statements'),
  tabItem('rp', 'statements'),
  tabItem('tb', 'statements', true),
  tabItem('ar', 'owes'),
  tabItem('ap', 'owes'),
  // Deposit and balance collected per salesman (owner 2026-09-12; docs/bugs/0825).
  tabItem('collection', 'sales'),
  {
    id: 'fair', label: 'Sales report · fairs', title: 'Sales report', group: 'sales',
    path: '/reports/fair-report', navTo: '/reports/fair-report', gate: SALES_REPORT_GATE,
  },
  // Every product the month sold, ranked by gross profit after its share of the gifts (owner 2026-10-05).
  tabItem('products', 'sales'),
  // Every product change on a sales order: did the selling change cover the cost change? By month (owner 2026-11-23).
  tabItem('changes', 'sales'),
  // The same changes added up P&L-style, by month and by salesperson (owner 2026-11-23: 类似 p&L).
  tabItem('changesum', 'sales'),
  // The month's shipped DOs: how much came from this month's orders, the rest from earlier ones (owner 2026-11-24).
  tabItem('sotodo', 'sales'),
  // What each event cost, from the ledger — voucher and AP invoice lines tagged with it (owner 2026-09-30, 5a).
  tabItem('events', 'events'),
  // Each fair's commission and each order's under it — goods × brand rate once 30% is paid (owner 2026-10-20).
  tabItem('commission', 'events'),
  // What delivery cost by DO — by region, per trip (our lorries overall: the month's lorry cost ÷ its trips; 3PL
  // bill lines), setup & dismantle, repairs by lorry (owner 2026-10-29).
  tabItem('logistics', 'events'),
  // What each acquirer charged against the gross, per month (owner 2026-09-12; docs/bugs/0826).
  tabItem('charges', 'cards'),
  // The Dashboard (owner 2026-09-21: the Hookka Dashboard, trading edition — the statements' actuals beside the
  // Forecast P&L).
  { id: 'dashboard', label: 'Dashboard', group: 'plan', path: '/scm/finance-dashboard', navTo: '/scm/finance-dashboard', gate: FORECAST_GATE },
  tabItem('je', 'books', true),
  tabItem('gl', 'books', true),
  // Finance's corrections to recorded payments (docs/bugs/0785) — a report (owner: 包括那个 finance 改
  // sales order 的报告).
  tabItem('corrections', 'audit'),
];

/** The P&L entry's picker (owner 2026-11-25): first the category — Actual by
 *  sales invoice (the books), Performance by sales order, Forecast — then
 *  Overall or Department. A choice opens a report of the list; the Department
 *  P&L takes its basis from `dbasis` (none reads as Performance there). The
 *  Forecast's departments are not built yet. */
export type PnlCategory = 'actual' | 'performance' | 'forecast';
export type PnlPart = 'overall' | 'department';
export type PnlChoice = { category: PnlCategory; part: PnlPart; report: ReportId; dbasis: 'actual' | 'performance' | null };

export const PNL_CATEGORIES: ReadonlyArray<{ id: PnlCategory; label: string }> = [
  { id: 'actual', label: 'Actual' },
  { id: 'performance', label: 'Performance' },
  { id: 'forecast', label: 'Forecast' },
];
export const PNL_PARTS: ReadonlyArray<{ id: PnlPart; label: string }> = [
  { id: 'overall', label: 'Overall' },
  { id: 'department', label: 'Department' },
];
export const PNL_CHOICES: readonly PnlChoice[] = [
  { category: 'actual', part: 'overall', report: 'pnl', dbasis: null },
  { category: 'actual', part: 'department', report: 'departments', dbasis: 'actual' },
  { category: 'performance', part: 'overall', report: 'performance', dbasis: null },
  { category: 'performance', part: 'department', report: 'departments', dbasis: 'performance' },
  { category: 'forecast', part: 'overall', report: 'forecast', dbasis: null },
];

/** A P&L of the picker: the list shows them as one entry, P&L. */
export const isPnlReport = (id: ReportId): boolean => PNL_CHOICES.some((c) => c.report === id);

/** The choice a page is: its report, and on the Department P&L its basis. */
export function pnlChoiceOf(id: ReportId, dbasis: string | null): PnlChoice | null {
  const basis = dbasis === 'actual' ? 'actual' : 'performance';
  return PNL_CHOICES.find((c) => c.report === id && (c.dbasis == null || c.dbasis === basis)) ?? null;
}

/** A member of the sidebar's one Reports entry: a sidebar entry (NavTab) in
 *  all but name — its address, name, icon and gate. */
export type ReportNavMember = { to: string; label: string; icon: LucideIcon } & ReportGate;

/** The sidebar's Reports entry's members (batch 6 §1.1): every report with a
 *  gate of its own, at the address its old sidebar entry had. Hidden from the
 *  sidebar — they decide whether the one entry shows, where it goes and when it
 *  is lit, so they carry the entry's own icon; the phone's menu reads them the
 *  same way. */
export const REPORT_NAV_MEMBERS: ReportNavMember[] = REPORT_CATALOG.flatMap((r) => (
  r.gate ? [{ to: r.navTo, label: r.label, icon: BarChart3, ...r.gate }] : []
));

export const reportById = (id: ReportId): ReportItem => {
  const item = REPORT_CATALOG.find((r) => r.id === id);
  if (!item) throw new Error(`No report ${id}`);
  return item;
};

/** The report an Accounting tab is, when it is one. Journal entries, the
 *  General ledger and the Trial balance are reports only when opened from the
 *  report list (`in=reports`); from Books they are Books pages. */
export function reportOfAccountingTab(tab: AccountingTab, inReports: boolean): ReportItem | null {
  const item = REPORT_CATALOG.find((r) => r.tab === tab);
  if (!item) return null;
  return item.inReports && !inReports ? null : item;
}

/** A shared report range, ISO `YYYY-MM-DD`. */
export type ReportRange = { from: string; to: string };

/** Where a report opens: its page, its tab, `in=reports` for a Books page, and
 *  the range in use — so the dates follow the reader from report to report. */
export function reportHref(item: ReportItem, range?: ReportRange | null): string {
  const q = new URLSearchParams();
  if (item.tab) q.set('tab', item.tab);
  if (item.inReports) q.set('in', 'reports');
  if (range && range.from && range.to) {
    q.set('from', range.from);
    q.set('to', range.to);
  }
  const s = q.toString();
  return s ? `${item.path}?${s}` : item.path;
}
