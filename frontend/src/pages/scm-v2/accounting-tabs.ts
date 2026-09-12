/* The Accounting page's tabs, as the URL names them (`/scm/accounting?tab=…`).
   The Finance sidebar deep-links them — Books, Reports and Setup groups
   (docs/bugs/0824) — so the set lives here, where the sidebar's test can read
   it without loading the page. A tab the URL does not name falls back to the
   page's own default. */
/* Each tab's title, as the page header names it once the tab strip is gone
   (owner 2026-09-12: 只靠侧栏就好，不然太乱了; docs/bugs/0841) — the Finance
   sidebar is the one way in, and "Accounting · P&L" says where you are. */
export const ACCOUNTING_TAB_TITLES = {
  coa: 'Chart of Accounts',
  groups: 'Item Groups',
  je: 'Journal Entries',
  gl: 'General Ledger',
  tb: 'Trial Balance',
  close: 'Month-end',
  pnl: 'P&L',
  bs: 'Balance Sheet',
  rp: 'Receipts & Payments',
  ar: 'AR Aging',
  ap: 'AP Aging',
  check: 'Self-check',
  corrections: 'Corrections',
  collection: 'Collection',
  charges: 'Merchant charges',
  performance: 'Performance P&L',
} as const;

export type AccountingTab = keyof typeof ACCOUNTING_TAB_TITLES;

export const ACCOUNTING_TABS = Object.keys(ACCOUNTING_TAB_TITLES) as readonly AccountingTab[];

export const accountingTabFromSearch = (raw: string | null | undefined): AccountingTab | null =>
  (ACCOUNTING_TABS as readonly string[]).includes(raw ?? '') ? (raw as AccountingTab) : null;
