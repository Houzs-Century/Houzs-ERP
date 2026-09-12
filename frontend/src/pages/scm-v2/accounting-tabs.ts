/* The Accounting page's tabs, as the URL names them (`/scm/accounting?tab=…`).
   The Finance sidebar deep-links them — Books, Reports and Setup groups
   (docs/bugs/0824) — so the set lives here, where the sidebar's test can read
   it without loading the page. A tab the URL does not name falls back to the
   page's own default. */
export const ACCOUNTING_TABS = [
  'coa', 'groups', 'je', 'gl', 'tb', 'close', 'pnl', 'bs', 'rp', 'ar', 'ap', 'check', 'corrections', 'collection', 'charges', 'performance',
] as const;

export type AccountingTab = (typeof ACCOUNTING_TABS)[number];

export const accountingTabFromSearch = (raw: string | null | undefined): AccountingTab | null =>
  (ACCOUNTING_TABS as readonly string[]).includes(raw ?? '') ? (raw as AccountingTab) : null;
