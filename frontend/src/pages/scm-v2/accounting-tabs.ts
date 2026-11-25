/* The Accounting page's tabs, as the URL names them (`/scm/accounting?tab=…`).
   The Finance sidebar deep-links them — Books, Reports and Setup groups
   (docs/bugs/0824) — so the set lives here, where the sidebar's test can read
   it without loading the page. A tab the URL does not name falls back to the
   page's own default. */
/* Each tab's title, as the page header names it once the tab strip is gone
   (owner 2026-09-12: 只靠侧栏就好，不然太乱了; docs/bugs/0841) — the Finance
   sidebar is the one way in, and "Accounting · P&L" says where you are.
   In sentence case, as the owner's Claude Design names them (batch 6 §1.1):
   the header, the report list and the workspace tab all read these. */
export const ACCOUNTING_TAB_TITLES = {
  coa: 'Chart of accounts',
  groups: 'Item groups',
  je: 'Journal entries',
  gl: 'General ledger',
  tb: 'Trial balance',
  close: 'Stock close',
  commrel: 'Commission release',
  pnl: 'P&L',
  bs: 'Balance sheet',
  rp: 'Cash flow',
  ar: 'AR aging',
  ap: 'AP aging',
  check: 'Self-check',
  corrections: 'Corrections',
  collection: 'Collection',
  charges: 'Merchant charges',
  performance: 'Performance P&L',
  events: 'Event costs',
  commission: 'Event commission',
  products: 'Product profit',
  changes: 'Product changes',
  changesum: 'Product changes P&L',
  sotodo: 'SO conversion & backlog',
  departments: 'Department P&L',
} as const;

export type AccountingTab = keyof typeof ACCOUNTING_TAB_TITLES;

export const ACCOUNTING_TABS = Object.keys(ACCOUNTING_TAB_TITLES) as readonly AccountingTab[];

export const accountingTabFromSearch = (raw: string | null | undefined): AccountingTab | null =>
  (ACCOUNTING_TABS as readonly string[]).includes(raw ?? '') ? (raw as AccountingTab) : null;

/** The Logistics cost tab (`?tab=logistics`) is the Department P&L's Logistics now
    (owner 2026-11-25): an old address lands there, its dates and view kept, its
    Show / % / split switches under the Department P&L's names. */
export function logisticsMovedTo(search: URLSearchParams): string {
  const renamed: Record<string, string> = { lm: 'dm', lsplit: 'dsplit', lpct: 'dpct' };
  const q = new URLSearchParams({ tab: 'departments', dv: 'logistics' });
  for (const [k, v] of search) {
    if (k !== 'tab' && k !== 'dv') q.set(renamed[k] ?? k, v);
  }
  return `/scm/accounting?${q.toString()}`;
}
