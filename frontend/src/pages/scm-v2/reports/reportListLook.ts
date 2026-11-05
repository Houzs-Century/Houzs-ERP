// ----------------------------------------------------------------------------
// reportListLook — how the report list (reports/ReportRail) draws each report
// of reports-catalog: its icon and its one-line description, shown on hover
// (the owner's Claude Design, batch 6 §4.1).
//
// Apart from the catalog on purpose: the sidebar's one Reports entry reads the
// catalog's names, addresses and gates, and the sidebar ships in the app's
// first download (scripts/check-bundle-size.mjs). The icons and sentences are
// only the list's, and the list is loaded with the reports. Keyed by ReportId,
// so a report the catalog adds without its look fails the typecheck.
// ----------------------------------------------------------------------------

import type { LucideIcon } from 'lucide-react';
import {
  Banknote, BarChart3, BookOpen, CalendarDays, CreditCard, FileText, Flag, Gauge, HandCoins, History,
  LayoutDashboard, ListChecks, Package, Scale, TrendingUp, Truck, Users, Wallet,
} from 'lucide-react';
import type { ReportId } from '../reports-catalog';

export const REPORT_LOOK: Readonly<Record<ReportId, { icon: LucideIcon; desc: string }>> = {
  pnl: { icon: BarChart3, desc: 'Income and expenses for a period on the report layout, with each line’s % of sales' },
  bs: { icon: Scale, desc: 'What the company owns and owes as at a day, with each line’s % of total assets' },
  rp: { icon: Banknote, desc: 'Money in and out of every bank and cash account, by layout row' },
  tb: { icon: ListChecks, desc: 'Debits and credits of every account; the difference must be 0.00' },
  ar: { icon: HandCoins, desc: 'What each debtor owes as at a day, by invoice month or days, with unapplied money' },
  ap: { icon: Wallet, desc: 'What is owed to each creditor as at a day, by invoice month or days, with unapplied money' },
  collection: { icon: Users, desc: 'Deposit and balance collected per salesman, for orders opened in a period by SO date' },
  fair: { icon: TrendingUp, desc: 'Sales orders, delivery orders and invoices anchored on the fair, and each fair’s P&L' },
  performance: { icon: Gauge, desc: 'Sales and cost from the sales orders by product group, with operating expense as a % of sales' },
  products: { icon: Package, desc: 'Every product the month sold, ranked by gross profit after its share of the gifts' },
  events: { icon: CalendarDays, desc: 'What each event cost, from the voucher and bill lines tagged with it' },
  commission: { icon: Users, desc: 'Each fair’s commission and the orders under it' },
  logistics: { icon: Truck, desc: 'What delivery cost: by region, per trip, and setup & dismantle' },
  charges: { icon: CreditCard, desc: 'What each merchant charged against the gross, month by month, cash and online included' },
  forecast: { icon: Flag, desc: 'Months across, P&L accounts down on the layout tree, a target per account' },
  dashboard: { icon: LayoutDashboard, desc: 'The statements’ actuals beside the forecast, per month or quarter' },
  je: { icon: BookOpen, desc: 'Every journal with its lines, search and filters' },
  gl: { icon: FileText, desc: 'One account’s lines with a running balance, any date range' },
  corrections: { icon: History, desc: 'Every Finance edit to a customer payment: before and after, by whom, when and why' },
};
