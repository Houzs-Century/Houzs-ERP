// ----------------------------------------------------------------------------
// acc/opening-balance — the books' opening, kept on the Opening Balance page
// (Finance › Setup; owner 2026-10-28: 「然后确定一下我是会有一个opening balance
// maintainence 表是吗？」 — yes, and 「这个你帮我导入哦」: the import fills it,
// the page keeps it). AutoCount's own Opening Balance screen in the ERP's terms:
//   • ACCOUNTS — the OPENING journal's lines: every account at its balance on
//     the old book's last day, except the parties (creditors and other debtors
//     are opening papers of their own) and the stock (its own tab);
//   • STOCK — the opening stock per bucket, on STOCKS AT THE BEGINNING
//     (600-000x) and in acc_company_settings.opening_stock, the figure the
//     statements open on (acc/books-opening.ts);
//   • CREDITORS / OTHER DEBTORS — the opening papers (AP invoices, supplier
//     credit notes, other-debtor bills and receipts), each flagged `opening`;
//   • the CLEARING account (190-0000 OPENING BALANCE CLEARING) is the other
//     side of every opening paper and the journal's balancing line, so it reads
//     nil when the opening balances — AutoCount's "opening balance difference".
//     The owner locks the opening only once it is nil.
// Pure: the routes (scm/routes/accounting-opening.ts) read and write.
// ----------------------------------------------------------------------------

import { STOCK_BUCKETS, type StockBucket } from '../scm/lib/stock-bucket';
import type { RuleLine } from './rules';

export const OPENING_CLEARING = '190-0000';
export const OPENING_SOURCE = 'OPENING';

export type OpeningAccountLine = { code: string; drSen: number; crSen: number };

const wholeSen = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** The account lines a save may book, or the sentence that refuses them.
    `refused` names each account the opening journal may not carry, and why
    (a control, a stock account, the clearing, a header, an unknown code). */
export function checkAccountLines(lines: OpeningAccountLine[], known: ReadonlySet<string>, refused: ReadonlyMap<string, string>): string | null {
  const seen = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const code = String(l?.code ?? '').trim();
    if (!code) return `Line ${i + 1} has no account.`;
    if (!wholeSen(l.drSen) || !wholeSen(l.crSen)) return `${code}: the amount must be whole sen, not below zero.`;
    if (l.drSen > 0 && l.crSen > 0) return `${code}: a line is a debit or a credit, not both.`;
    if (l.drSen === 0 && l.crSen === 0) return `${code}: the line has no amount — remove it instead.`;
    if (seen.has(code)) return `${code} is on the opening twice — one line per account.`;
    seen.add(code);
    const why = refused.get(code);
    if (why) return `${code} ${why}`;
    if (!known.has(code)) return `${code} is not on the chart of accounts.`;
  }
  return null;
}

/** The opening stock a save may book, or the sentence that refuses it. */
export function checkStock(buckets: Partial<Record<string, unknown>>): { ok: true; stock: Record<StockBucket, number> } | { ok: false; message: string } {
  const stock = Object.fromEntries(STOCK_BUCKETS.map((b) => [b, 0])) as Record<StockBucket, number>;
  for (const [k, v] of Object.entries(buckets ?? {})) {
    if (!(STOCK_BUCKETS as readonly string[]).includes(k)) return { ok: false, message: `"${k}" is not a stock bucket.` };
    if (!wholeSen(v)) return { ok: false, message: `The ${k} stock must be whole sen, not below zero.` };
    stock[k as StockBucket] = v as number;
  }
  return { ok: true, stock };
}

/** The OPENING journal: the accounts, the stock on each bucket's STOCKS AT THE
    BEGINNING account, and the clearing's balancing line — what the opening
    papers carry on the other side of it. */
export function openingJournalLines(
  accounts: OpeningAccountLine[],
  stock: Record<StockBucket, number>,
  stockCodes: Record<StockBucket, string>,
  clearing: string = OPENING_CLEARING,
): RuleLine[] {
  const lines: RuleLine[] = [
    ...accounts.map((a) => ({ accountCode: a.code, debitSen: a.drSen, creditSen: a.crSen, notes: 'Opening balance' })),
    ...STOCK_BUCKETS.filter((b) => stock[b] > 0).map((b) => ({ accountCode: stockCodes[b], debitSen: stock[b], creditSen: 0, notes: `Opening stock — ${b}` })),
  ];
  const net = lines.reduce((s, l) => s + l.debitSen - l.creditSen, 0);
  if (net !== 0) lines.push({ accountCode: clearing, debitSen: Math.max(-net, 0), creditSen: Math.max(net, 0), notes: 'The creditors and other debtors, carried by their opening papers' });
  return lines;
}

export type OpeningPaperKind = 'API' | 'SCN' | 'ODB' | 'ODR';
export const OPENING_PAPER_KINDS: readonly OpeningPaperKind[] = ['API', 'SCN', 'ODB', 'ODR'];

/** An opening paper's journal — the import's own shape (scripts/open-houzs-books-start.mjs):
    a bill owes the party and debits the clearing, a credit the other way round. */
export function openingPaperLines(
  kind: OpeningPaperKind,
  p: { docNo: string; amountSen: number; party: { code: string | null; name: string }; control: string; clearing?: string },
): RuleLine[] {
  const clearing = p.clearing ?? OPENING_CLEARING;
  const amt = p.amountSen;
  if (kind === 'API') return [
    { accountCode: clearing, debitSen: amt, creditSen: 0, notes: `Opening bill ${p.docNo}` },
    { accountCode: p.control, debitSen: 0, creditSen: amt, partyType: 'SUPPLIER', partyCode: p.party.code, partyName: p.party.name, notes: `AP invoice ${p.docNo}` },
  ];
  if (kind === 'SCN') return [
    { accountCode: p.control, debitSen: amt, creditSen: 0, partyType: 'SUPPLIER', partyCode: p.party.code, partyName: p.party.name, notes: `Supplier credit note ${p.docNo}` },
    { accountCode: clearing, debitSen: 0, creditSen: amt, notes: `Opening credit ${p.docNo}` },
  ];
  if (kind === 'ODB') return [
    { accountCode: p.control, debitSen: amt, creditSen: 0, partyType: 'ODEBTOR', partyCode: null, partyName: p.party.name, notes: `Other debtor ${p.party.name} — ${p.docNo}` },
    { accountCode: clearing, debitSen: 0, creditSen: amt, notes: `Opening bill ${p.docNo}` },
  ];
  return [
    { accountCode: clearing, debitSen: amt, creditSen: 0, notes: `Opening credit ${p.docNo}` },
    { accountCode: p.control, debitSen: 0, creditSen: amt, partyType: 'ODEBTOR', partyCode: null, partyName: p.party.name, notes: `Other debtor settlement — ${p.docNo}` },
  ];
}
