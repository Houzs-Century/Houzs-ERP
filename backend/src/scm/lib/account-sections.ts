// ----------------------------------------------------------------------------
// account-sections — the AutoCount "account type" tree, one home.
//
// The owner (2026-09-06, his AutoCount screenshot in hand): chart of account
// 每个 account type 的 header 能做吗 … 你先帮我分类,然后我自己还能调动(用拖拉式).
// A SECTION is the top-level node his accountant's chart hangs every account
// under — CAPITAL, CURRENT ASSETS, COST OF GOODS SOLD… — and it DECIDES the
// five-way account_type (CAPITAL is EQUITY, COST OF GOODS SOLD is EXPENSE),
// never the other way round. Stored on scm.accounts.section (migration
// 20260906T0900), seeded once by the code-range rule below, and thereafter the
// owner's to move by dragging on the chart page. Reports read the SECTION.
//
// This file is the vocabulary's ONLY home: the API hands the ordered list to
// the screens (GET /accounting/chart and /accounting/accounts carry it), the
// import validates against it, and the migration's CASE mirrors
// defaultSectionFor — change one, change both.
// ----------------------------------------------------------------------------

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export type AccountSection = { section: string; type: AccountType };

/* AutoCount's order, top to bottom — the order the chart page renders. */
export const ACCOUNT_SECTIONS: ReadonlyArray<AccountSection> = [
  { section: 'CAPITAL', type: 'EQUITY' },
  { section: 'RETAINED EARNING', type: 'EQUITY' },
  { section: 'FIXED ASSETS', type: 'ASSET' },
  { section: 'OTHER ASSETS', type: 'ASSET' },
  { section: 'CURRENT ASSETS', type: 'ASSET' },
  { section: 'CURRENT LIABILITIES', type: 'LIABILITY' },
  { section: 'LONG TERM LIABILITIES', type: 'LIABILITY' },
  { section: 'OTHER LIABILITIES', type: 'LIABILITY' },
  { section: 'SALES', type: 'INCOME' },
  { section: 'SALES ADJUSTMENTS', type: 'INCOME' },
  { section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
  { section: 'OTHER INCOMES', type: 'INCOME' },
  { section: 'EXTRA-ORDINARY INCOME', type: 'INCOME' },
  { section: 'EXPENSES', type: 'EXPENSE' },
  { section: 'TAXATION', type: 'EXPENSE' },
  { section: 'APPROPRIATION A/C', type: 'EQUITY' },
];

const byName = new Map(ACCOUNT_SECTIONS.map((s) => [s.section, s.type]));

export const isAccountSection = (s: unknown): s is string =>
  typeof s === 'string' && byName.has(s);

/** The type a section decides. Callers validate with isAccountSection first. */
export const sectionType = (section: string): AccountType | undefined => byName.get(section);

/**
 * Where an account lands when nobody has placed it yet — the seed rule the
 * migration ran once over the owner's 397 codes, kept here so a code created
 * or imported without a section takes the same shelf. Code ranges are his
 * chart's own convention (2xx fixed / 3xx current assets, 460 borrowings,
 * 5xx sales, 6xx cost of goods, 9xx expenses, 950 taxation); the owner drags
 * anything the rule gets wrong. Text comparison on 'NNN-XXXX' orders by the
 * three-digit prefix exactly as the numbers do.
 */
export function defaultSectionFor(type: string, code: string): string {
  const c = String(code);
  switch (type) {
    case 'EQUITY':
      return c < '150' ? 'CAPITAL' : 'RETAINED EARNING';
    case 'ASSET':
      if (c >= '200' && c < '210') return 'FIXED ASSETS';
      if (c >= '210' && c < '300') return 'OTHER ASSETS';
      return 'CURRENT ASSETS';
    case 'LIABILITY':
      if (c >= '460' && c < '470') return 'LONG TERM LIABILITIES';
      if (c >= '470') return 'OTHER LIABILITIES';
      return 'CURRENT LIABILITIES';
    case 'INCOME':
      if (c < '510') return 'SALES';
      if (c < '530') return 'SALES ADJUSTMENTS';
      if (c >= '800' && c < '900') return 'EXTRA-ORDINARY INCOME';
      return 'OTHER INCOMES';
    default: // EXPENSE
      if (c < '700') return 'COST OF GOODS SOLD';
      if (c >= '950' && c < '960') return 'TAXATION';
      return 'EXPENSES';
  }
}
