// ----------------------------------------------------------------------------
// reports-catalog — the Finance report list (the owner's Claude Design,
// batch 6 §4.1): every report, the group it sits under, its icon and its
// one-line description, in the design's order. ONE home: the report list
// (reports/ReportRail) reads it, and so will the sidebar's Reports entry
// (batch 6 §1.1) — a second copy of these names would be a second decision.
//
// A report's name is the Accounting tab's own title where it is a tab
// (accounting-tabs ACCOUNTING_TAB_TITLES), so the list, the header and the
// workspace tab can never name it three ways.
//
// WHO SEES WHICH REPORT is today's sidebar gate, unchanged: each report names
// the sidebar entry it mirrors (`navTo`), and the list shows it only where the
// sidebar would show that entry (makeNavFilter). The gate keeps its one home in
// the sidebar until its Reports group reads this list.
// ----------------------------------------------------------------------------

import type { LucideIcon } from 'lucide-react';
import {
  Banknote, BarChart3, BookOpen, CalendarDays, CreditCard, FileText, Flag, Gauge, HandCoins, History,
  LayoutDashboard, ListChecks, Package, Scale, TrendingUp, Truck, Users, Wallet,
} from 'lucide-react';
import { ACCOUNTING_TAB_TITLES, type AccountingTab } from './accounting-tabs';

export type ReportGroupId = 'statements' | 'owes' | 'sales' | 'events' | 'cards' | 'plan' | 'books' | 'audit';

export type ReportId =
  | 'pnl' | 'bs' | 'rp' | 'tb'
  | 'ar' | 'ap'
  | 'collection' | 'fair' | 'performance' | 'products'
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
  icon: LucideIcon;
  /** The one-line description the list shows on hover. */
  desc: string;
  /** Where it opens: the page, and the Accounting tab when it is one. */
  path: string;
  tab?: AccountingTab;
  /** Journal entries, General ledger and Trial balance are Books pages; opened
   *  from the list they carry `in=reports`, so the list and its header follow. */
  inReports?: boolean;
  /** The sidebar entry whose gate decides who sees this report. */
  navTo: string;
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
const tabItem = (
  tab: AccountingTab & ReportId, group: ReportGroupId, icon: LucideIcon, desc: string, books = false,
): ReportItem => ({
  id: tab,
  label: ACCOUNTING_TAB_TITLES[tab],
  group,
  icon,
  desc,
  path: ACCOUNTING,
  tab,
  ...(books ? { inReports: true } : {}),
  navTo: `${ACCOUNTING}?tab=${tab}`,
});

/** Every report, in the design's order (the list draws them group by group). */
export const REPORT_CATALOG: readonly ReportItem[] = [
  tabItem('pnl', 'statements', BarChart3, 'Income and expenses for a period on the report layout, with each line’s % of sales'),
  tabItem('bs', 'statements', Scale, 'What the company owns and owes as at a day, with each line’s % of total assets'),
  tabItem('rp', 'statements', Banknote, 'Money in and out of every bank and cash account, by layout row'),
  tabItem('tb', 'statements', ListChecks, 'Debits and credits of every account; the difference must be 0.00', true),
  tabItem('ar', 'owes', HandCoins, 'What each debtor owes as at a day, by invoice month or days, with unapplied money'),
  tabItem('ap', 'owes', Wallet, 'What is owed to each creditor as at a day, by invoice month or days, with unapplied money'),
  tabItem('collection', 'sales', Users, 'Deposit and balance collected per salesman, for orders opened in a period by SO date'),
  {
    id: 'fair', label: 'Sales report · fairs', title: 'Sales report', group: 'sales', icon: TrendingUp,
    desc: 'Sales orders, delivery orders and invoices anchored on the fair, and each fair’s P&L',
    path: '/reports/fair-report', navTo: '/reports/fair-report',
  },
  tabItem('performance', 'sales', Gauge, 'Sales and cost from the sales orders by product group, with operating expense as a % of sales'),
  tabItem('products', 'sales', Package, 'Every product the month sold, ranked by gross profit after its share of the gifts'),
  tabItem('events', 'events', CalendarDays, 'What each event cost, from the voucher and bill lines tagged with it'),
  tabItem('commission', 'events', Users, 'Each fair’s commission and the orders under it'),
  tabItem('logistics', 'events', Truck, 'What delivery cost: by region, per trip, and setup & dismantle'),
  tabItem('charges', 'cards', CreditCard, 'What each merchant charged against the gross, month by month, cash and online included'),
  {
    id: 'forecast', label: 'Forecast P&L', group: 'plan', icon: Flag,
    desc: 'Months across, P&L accounts down on the layout tree, a target per account',
    path: '/scm/forecast', navTo: '/scm/forecast',
  },
  {
    id: 'dashboard', label: 'Dashboard', group: 'plan', icon: LayoutDashboard,
    desc: 'The statements’ actuals beside the forecast, per month or quarter',
    path: '/scm/finance-dashboard', navTo: '/scm/finance-dashboard',
  },
  tabItem('je', 'books', BookOpen, 'Every journal with its lines, search and filters', true),
  tabItem('gl', 'books', FileText, 'One account’s lines with a running balance, any date range', true),
  tabItem('corrections', 'audit', History, 'Every Finance edit to a customer payment: before and after, by whom, when and why'),
];

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
