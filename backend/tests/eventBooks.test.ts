/* The books on the PMS event page (owner 2026-10-01, payment-request item 5:
   付款接进这页 — 某一行只要有了入账，就用入账的数字，取代原本手填的或自动算的).
   Pinned on scm/lib/event-books.ts:
     • a leg fills the row its account names; an expense account without a row
       fills Others Costing; any other account without one is not a cost;
     • only legs the books count — posted, on neither side of a reversal pair;
     • a row the books fill gives up its typed AND auto lines (set aside, not
       lost), and a row they do not fill keeps its own;
     • a credit (a recovery) lowers its row;
     • a failed read changes nothing and says why;
     • the category → row map over every picker category — the referee for
       Projects.tsx NAMED_COSTS, the snapshot's own rows. */

import { describe, expect, test } from 'vitest';
import { applyEventBooks, booksLinesFor, readEventBooks, readEventBooksMany, rowOfCategory, withScnCredits, type BooksLeg } from '../src/scm/lib/event-books';
import { LEDGER_COST_CATEGORIES } from '../src/services/projects';

const leg = (over: Partial<BooksLeg> = {}): BooksLeg => ({
  leg_id: 'leg-1',
  account_code: '900-R032',
  debit_sen: 800000,
  credit_sen: 0,
  notes: null,
  je_no: 'JE-2610-001',
  entry_date: '2026-10-05',
  source_type: 'PV',
  source_doc_no: 'PV-2610-001',
  posted: true,
  reversed: false,
  reversed_by_je: null,
  account_name: 'RENTAL - EXHIBITION',
  account_type: 'EXPENSE',
  pms_row: 'rental',
  ...over,
});

type Line = { id: number; project_id: number; kind: string; category: string; amount: number; auto_source?: string | null; source?: string | null };
const typed = (id: number, category: string, amount: number, over: Partial<Line> = {}): Line => ({ id, project_id: 7, kind: 'cost', category, amount, ...over });
const sumOf = (lines: Array<{ kind: string; category: string; amount: number }>, ...cats: string[]) =>
  lines.filter((l) => l.kind === 'cost' && cats.includes(l.category)).reduce((s, l) => s + l.amount, 0);

describe('a leg on the event page', () => {
  test('fills the row its account names, carrying the number of the document that posted it', () => {
    const [line, ...rest] = booksLinesFor(7, [leg()]);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      project_id: 7, kind: 'cost', category: 'rental', amount: 8000, occurred_at: '2026-10-05',
      source: 'books', doc_no: 'PV-2610-001', account_code: '900-R032', account_name: 'RENTAL - EXHIBITION',
      description: 'RENTAL - EXHIBITION', auto_source: null, r2_key: null,
    });
    expect(line!.id).toBeLessThan(-999_999_999);
  });

  test('an expense account without a row fills Others Costing; a deposit without one is not a cost; the rental advance (an asset WITH a row) counts', () => {
    const lines = booksLinesFor(7, [
      leg({ leg_id: 'a', account_code: '900-E099', account_name: 'SUNDRY', pms_row: null, debit_sen: 5000, notes: 'Banner' }),
      leg({ leg_id: 'b', account_code: '340-0030', account_name: 'DEPOSIT - EXHIBITION / ROADSHOW', account_type: 'ASSET', pms_row: null, debit_sen: 300000 }),
      leg({ leg_id: 'c', account_code: '360-0010', account_name: 'ADVANCE - EXHBITION/ROADSHOW RENTAL', account_type: 'ASSET', pms_row: 'rental', debit_sen: 200000 }),
    ]);
    expect(lines.map((l) => [l.account_code, l.category, l.amount, l.description])).toEqual([
      ['900-E099', 'others', 50, 'Banner'],
      ['360-0010', 'rental', 2000, 'ADVANCE - EXHBITION/ROADSHOW RENTAL'],
    ]);
  });

  test('counts only what the books count — a draft, a reversed original and its contra drop out', () => {
    const lines = booksLinesFor(7, [
      leg({ leg_id: 'draft', posted: false }),
      leg({ leg_id: 'orig', reversed: true, reversed_by_je: 'je-contra' }),
      leg({ leg_id: 'contra', debit_sen: 0, credit_sen: 800000, reversed_by_je: 'je-orig' }),
      leg({ leg_id: 'live', debit_sen: 650000, source_doc_no: 'PV-2610-002' }),
    ]);
    expect(lines.map((l) => [l.doc_no, l.amount])).toEqual([['PV-2610-002', 6500]]);
  });

  test('a manual entry with no document number shows its journal number', () => {
    const [line] = booksLinesFor(7, [leg({ source_type: 'MANUAL', source_doc_no: null, je_no: 'JE-2610-009' })]);
    expect(line!.doc_no).toBe('JE-2610-009');
  });
});

describe('a row the books fill', () => {
  test('gives up its typed and auto lines — set aside, not lost — while every other row keeps its own', () => {
    const ledger: Line[] = [
      typed(1, 'rental', 7500),
      typed(2, 'transport', 300),
      typed(3, 'transport_fee', 900, { auto_source: 'auto:transport' }),
      typed(4, 'setup', 1200),
      typed(5, 'cogs_bedframe', 4000),
      typed(6, 'contractor', 600),
      typed(8, 'deposit_refund', 500, { kind: 'income' }),
    ];
    const { lines, books } = applyEventBooks(7, ledger, {
      ok: true,
      legs: [
        leg(),
        leg({ leg_id: 't', account_code: '900-T031', account_name: 'TRANSPORT FEE', pms_row: 'transport_fee', debit_sen: 120000, source_type: 'API', source_doc_no: 'HC-API-2610-001' }),
      ],
    }, LEDGER_COST_CATEGORIES);
    expect(books).toMatchObject({ ok: true, reason: null, rows: ['rental', 'transport_fee'] });
    expect(books.replaced.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(books.closed_categories).toEqual(['rental', 'transport', 'transport_fee']);
    expect(lines.filter((l) => l.source !== 'books').map((l) => l.id)).toEqual([4, 5, 6, 8]);
    // What the page sums, row by row.
    expect(sumOf(lines, 'rental')).toBe(8000);
    expect(sumOf(lines, 'transport', 'transport_fee')).toBe(1200);
    expect(sumOf(lines, 'setup')).toBe(1200);
    expect(sumOf(lines, 'cogs_bedframe')).toBe(4000);
  });

  test('Others Costing in the books replaces every typed category without a row of its own — never COGS or Merchandise', () => {
    const ledger: Line[] = [
      typed(1, 'contractor', 600),
      typed(2, 'misc', 150),
      typed(3, 'merchandise', 80, { auto_source: 'auto:merchandise' }),
      typed(4, 'cogs_matt_sofa', 3000),
      typed(5, 'rental', 7000),
    ];
    const { lines, books } = applyEventBooks(7, ledger, {
      ok: true,
      legs: [leg({ account_code: '900-E002', account_name: 'EVENT EXPENSES', pms_row: 'others', debit_sen: 20000 })],
    }, LEDGER_COST_CATEGORIES);
    expect(books.rows).toEqual(['others']);
    expect(books.replaced.map((l) => l.id)).toEqual([1, 2]);
    expect(books.closed_categories).toEqual(['contractor', 'license', 'deposit', 'permit', 'accommodation', 'staffing', 'marketing', 'misc']);
    expect(lines.filter((l) => l.source !== 'books').map((l) => l.id)).toEqual([3, 4, 5]);
  });

  test('a credit lowers its row — a rental recovery billed back to the organiser', () => {
    const { lines } = applyEventBooks(7, [typed(1, 'rental', 7000)], {
      ok: true,
      legs: [leg(), leg({ leg_id: 'r', debit_sen: 0, credit_sen: 150000, source_type: 'ODB', source_doc_no: 'HC-ODB-2610-001' })],
    }, LEDGER_COST_CATEGORIES);
    expect(sumOf(lines, 'rental')).toBe(6500);
  });

  test('money only coming back does not replace the typed figure — it is taken off it (owner 2026-10-22)', () => {
    /* #343 [AKEMI] MALL MGT @ IOI CITY MALL PUTRAJAYA: rental typed 45,900; the
       books hold only HC-ODB-2609-004 billing the partner's half back. It read
       -22,950 and the Books-not-complete list said "missing". */
    const { lines, books } = applyEventBooks(7, [typed(1, 'rental', 45900)], {
      ok: true,
      legs: [leg({ leg_id: 'odb', debit_sen: 0, credit_sen: 2295000, source_type: 'ODB', source_doc_no: 'HC-ODB-2609-004' })],
    }, LEDGER_COST_CATEGORIES);
    expect(books.rows).toEqual([]);
    expect(books.replaced).toEqual([]);
    expect(books.closed_categories).toEqual([]);
    expect(sumOf(lines, 'rental')).toBe(22950);
    /* Once the mall's own rental is booked, the books fill the row as before. */
    const paid = applyEventBooks(7, [typed(1, 'rental', 45900)], {
      ok: true,
      legs: [leg({ leg_id: 'pv', debit_sen: 4590000 }), leg({ leg_id: 'odb', debit_sen: 0, credit_sen: 2295000, source_type: 'ODB' })],
    }, LEDGER_COST_CATEGORIES);
    expect(paid.books.rows).toEqual(['rental']);
    expect(sumOf(paid.lines, 'rental')).toBe(22950);
  });

  test('on a % row any leg still fills it, so a credit is never lost under the rate card', () => {
    const { books } = applyEventBooks(7, [], {
      ok: true,
      legs: [leg({ leg_id: 'c', account_code: '900-C003', account_name: 'COMMISSION', pms_row: 'commission', debit_sen: 0, credit_sen: 50000 })],
    }, LEDGER_COST_CATEGORIES);
    expect(books.rows).toEqual(['commission']);
  });

  test('no money on the event changes nothing', () => {
    const ledger = [typed(1, 'rental', 7000)];
    const out = applyEventBooks(7, ledger, { ok: true, legs: [] }, LEDGER_COST_CATEGORIES);
    expect(out.lines).toEqual(ledger);
    expect(out.books).toEqual({ ok: true, reason: null, rows: [], closed_categories: [], replaced: [] });
  });

  test('a failed read changes nothing and says why', () => {
    const ledger = [typed(1, 'rental', 7000)];
    const out = applyEventBooks(7, ledger, { ok: false, reason: 'relation "scm.journal_entry_lines" does not exist' }, LEDGER_COST_CATEGORIES);
    expect(out.lines).toEqual(ledger);
    expect(out.books).toEqual({ ok: false, reason: 'relation "scm.journal_entry_lines" does not exist', rows: [], closed_categories: [], replaced: [] });
  });
});

describe('reading the books', () => {
  test("asks for the event's legs in its own company, and reports a failed read instead of guessing", async () => {
    const calls: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          calls.push([sql, ...args]);
          /* The supplier notes' credits are a read of their own (none here). */
          return { all: async () => ({ results: /acc_credit_notes/.test(sql) ? [] : [leg()] }) };
        },
      }),
    } as unknown as D1Database;
    expect(await readEventBooks(db, 7, 1)).toEqual({ ok: true, legs: [leg()] });
    expect(calls[0]!.slice(1)).toEqual([7, 1]);
    expect(String(calls[0]![0])).toMatch(/WHERE l\.project_id = \? AND l\.company_id = \?/);
    /* The supplier notes' credits, by the same event and company (owner 2026-10-22). */
    expect(String(calls[1]![0])).toMatch(/acc_credit_notes/);
    expect(calls[1]!.slice(1)).toEqual([7, 1]);
    await readEventBooks(db, 7, null);
    expect(calls[2]!.slice(1)).toEqual([7]);

    const broken = { prepare: () => { throw new Error('no such table: scm.journal_entry_lines'); } } as unknown as D1Database;
    expect(await readEventBooks(broken, 7, 1)).toEqual({ ok: false, reason: 'no such table: scm.journal_entry_lines' });
  });
});

describe('the row of each typed category', () => {
  test('every picker category sits in the snapshot row Projects.tsx gives it', () => {
    expect(Object.fromEntries(LEDGER_COST_CATEGORIES.map((c) => [c, rowOfCategory(c)]))).toEqual({
      rental: 'rental',
      cogs: null, cogs_matt_sofa: null, cogs_bedframe: null, cogs_accessories: null,
      setup: 'setup',
      transport: 'transport_fee', transport_fee: 'transport_fee', transport_setup_dismantle: 'transport_setup_dismantle',
      commission: 'commission',
      merchandise: null,
      contractor: 'others', license: 'others', deposit: 'others', permit: 'others',
      accommodation: 'others', staffing: 'others', marketing: 'others', misc: 'others',
    });
  });
});

/* A supplier credit note comes off the row of the AP invoice it knocks off
   (owner 2026-10-22: 「这几张cn 不是knock off 着ap invoice…」, 「我不想要把他放在
   others」) — read at P&L time, the ledger untouched. */
describe('a supplier credit note knocking off an event\'s invoice', () => {
  /* HC-API-2610-030: the ZANOTTI booth's rental at IOIGECC, 18,000. */
  const bill = leg({ leg_id: 'api', debit_sen: 1_800_000, source_type: 'API', source_doc_no: 'HC-API-2610-030', je_no: 'JE-2610-0470' });
  /* HC-SCN-2610-004 knocks 8,000 off it — read as a credit on the invoice line's account. */
  const credit = leg({ leg_id: 'scn:n4:l1', debit_sen: 0, credit_sen: 800_000, source_type: 'SCN', source_doc_no: 'HC-SCN-2610-004', je_no: 'JE-2610-0505', notes: 'Credit note HC-SCN-2610-004 knocks off HC-API-2610-030' });
  /* Its own leg, had it been tagged: DISCOUNT RECEIVED — Others, were it counted. */
  const ownLeg = leg({ leg_id: 'own', account_code: '610-0001', account_name: 'DISCOUNT RECEIVED', pms_row: null, debit_sen: 0, credit_sen: 800_000, source_type: 'SCN', source_doc_no: 'HC-SCN-2610-004', je_no: 'JE-2610-0505' });

  test('comes off the invoice line\'s row — Rental 18,000 less 8,000 — never Others, never twice', () => {
    const legs = withScnCredits([bill, ownLeg], [credit]);
    expect(legs.map((l) => l.leg_id)).toEqual(['api', 'scn:n4:l1']);
    const { lines, books } = applyEventBooks(7, [typed(1, 'rental', 18000)], { ok: true, legs }, LEDGER_COST_CATEGORIES);
    expect(books.rows).toEqual(['rental']);
    expect(sumOf(lines, 'rental')).toBe(10000);
    expect(sumOf(lines, 'others')).toBe(0);
  });

  test('another supplier note\'s own legs are kept; no credits change nothing', () => {
    const other = { ...ownLeg, leg_id: 'other', source_doc_no: 'HC-SCN-2610-009' };
    expect(withScnCredits([bill, other], [credit]).map((l) => l.leg_id)).toEqual(['api', 'other', 'scn:n4:l1']);
    expect(withScnCredits([bill, ownLeg], []).map((l) => l.leg_id)).toEqual(['api', 'own']);
  });

  test('the page of events reads the credits too, each its own event\'s', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({
            results: /acc_credit_notes/.test(sql) ? [{ ...credit, project_id: 2267 }]
              : /payment_voucher_lines/.test(sql) ? []
              : [{ ...bill, project_id: 2267 }, { ...ownLeg, project_id: 2267 }, { ...bill, leg_id: 'b2', project_id: 307 }],
          }),
        }),
      }),
    } as unknown as D1Database;
    const read = await readEventBooksMany(db, [2267, 307], 1);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.byProject.get(2267)!.map((l) => l.leg_id)).toEqual(['api', 'scn:n4:l1']);
    expect(read.byProject.get(307)!.map((l) => l.leg_id)).toEqual(['b2']);
  });
});
