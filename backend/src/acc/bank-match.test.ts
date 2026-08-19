// What this file pins, all of it drawn from the real Maybank export
// (`Bank Statement/MBB - ACCOUNTACTIVITYREPORT_564418610346.csv`, 01–15 Aug):
//
//   • a credit and the charge taken back against it are ONE payout;
//   • three AEON credits sharing one reference on one day are THREE payouts,
//     and the grouping rule must not join them — this is the trap the naive
//     "same reference = same movement" rule falls into, and the file contains
//     it seventeen times;
//   • which acquirer a line belongs to comes from the rules table, never from
//     code — teaching the system a sixth bank is a config row;
//   • a statement is claimed only when exactly one can be, and every other
//     outcome says what a person has to look at, with BOTH numbers when they
//     disagree (§2.14).

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  groupBankMovements, recogniseAcquirer, matchBankMovements,
  type BankRecognitionRule, type PayableBatch,
} from './bank-match';
import type { BankLine } from './bank-parse';

let seq = 0;
const line = (over: Partial<BankLine> = {}): BankLine => ({
  lineNo: (seq += 1),
  bookedOn: '2026-08-09',
  description: 'CR/CARD SALES MN 32410011 DATED 31072026',
  reference: '00113107',
  amountSen: 728448,
  balanceSen: null,
  ...over,
});

/* The rules exactly as docs/acquirer-statement-formats.md records them. */
const RULES: BankRecognitionRule[] = [
  {
    acquirerCode: 'MBB',
    pattern: 'CARD SALES',
    tradingDatePattern: 'DATED\\s*(\\d{8})',
    merchantPattern: 'M/?N\\s*(\\d+)',
  },
  { acquirerCode: 'PBB', pattern: 'PBB-PBCS' },
  { acquirerCode: 'AEON', pattern: 'AEON CREDIT SERVICE' },
  {
    acquirerCode: 'HLB', pattern: 'CA Credit Advice',
    tradingDatePattern: 'MERCHANT\\s+(\\d{8})',
  },
];

describe('joining a credit to the charge taken back against it', () => {
  /* The real pair: RM 875.00 in and RM 3.94 out, same reference, same day. */
  it('makes one payout of a credit and its charge', () => {
    const movements = groupBankMovements([
      line({ amountSen: 87500, reference: 'D90200808', description: 'DR/CARD SALES M/N 2259020 DATED 08082026' }),
      line({ amountSen: -394, reference: 'D90200808', description: 'DR/CARD SALES M/N 2259020 DATED 08082026' }),
    ]);
    expect(movements).toHaveLength(1);
    expect(movements[0]!.amountSen).toBe(87106);
    expect(movements[0]!.chargeSen).toBe(394);
    expect(movements[0]!.lines).toHaveLength(2);
  });

  /* THE TRAP. Three AEON credits, one reference, one day — in the real file
     `MA458030163361` on 2026-08-03 carries RM 3,262.46, RM 6,619.48 and
     RM 10,114.61. Joined, they would invent a payout of RM 19,996.55. */
  it('never joins two credits, however much they share', () => {
    const movements = groupBankMovements([
      line({ amountSen: 326246, reference: 'MA458030163361', bookedOn: '2026-08-03', description: 'Book Transfer Third AEON CREDIT SERVICE' }),
      line({ amountSen: 661948, reference: 'MA458030163361', bookedOn: '2026-08-03', description: 'Book Transfer Third AEON CREDIT SERVICE' }),
      line({ amountSen: 1011461, reference: 'MA458030163361', bookedOn: '2026-08-03', description: 'Book Transfer Third AEON CREDIT SERVICE' }),
    ]);
    expect(movements).toHaveLength(3);
    expect(movements.map((m) => m.amountSen)).toEqual([326246, 661948, 1011461]);
    expect(movements.every((m) => m.chargeSen === 0)).toBe(true);
  });

  /* Half the retail credits in the file use the literal reference "Fund
     Transfer" — a shared word, not a shared transaction. */
  it('leaves alone credits that only share a generic reference', () => {
    const movements = groupBankMovements([
      line({ amountSen: 370000, reference: 'Fund Transfer', description: 'MBB CT- PERNIAGAAN USAHAJAY*' }),
      line({ amountSen: 400000, reference: 'Fund Transfer', description: 'MBB CT- SOMEBODY ELSE*' }),
    ]);
    expect(movements).toHaveLength(2);
  });

  it('does not join across days, or where there is no reference at all', () => {
    expect(groupBankMovements([
      line({ amountSen: 87500, reference: 'D9020', bookedOn: '2026-08-09' }),
      line({ amountSen: -394, reference: 'D9020', bookedOn: '2026-08-11' }),
    ])).toHaveLength(2);
    expect(groupBankMovements([
      line({ amountSen: 87500, reference: null }),
      line({ amountSen: -394, reference: null }),
    ])).toHaveLength(2);
  });

  /* A debit bigger than the credit is not a fee. Whatever it is, it is a
     person's problem, not a silent RM -x payout. */
  it('refuses to call a debit larger than its credit a charge', () => {
    const movements = groupBankMovements([
      line({ amountSen: 10000, reference: 'X1' }),
      line({ amountSen: -50000, reference: 'X1' }),
    ]);
    expect(movements).toHaveLength(2);
  });

  it('keeps the order the statement itself prints', () => {
    const movements = groupBankMovements([
      line({ lineNo: 30, amountSen: 100, reference: 'A' }),
      line({ lineNo: 10, amountSen: 200, reference: 'B' }),
      line({ lineNo: 20, amountSen: 300, reference: 'C' }),
    ]);
    expect(movements.map((m) => m.lines[0]!.lineNo)).toEqual([10, 20, 30]);
  });
});

describe('recognising whose money it is', () => {
  it('reads the acquirer, the trading day and the merchant number off the line', () => {
    const seen = recogniseAcquirer(RULES, {
      description: 'CR/CARD SALES MN 32410011 DATED 31072026', reference: '00113107',
    });
    expect(seen?.acquirerCode).toBe('MBB');
    /* The TRADING day (31 July), not the day the money landed (3 Aug). */
    expect(seen?.tradingDate).toBe('2026-07-31');
    expect(seen?.merchantNo).toBe('32410011');
  });

  it('recognises the other three real shapes', () => {
    expect(recogniseAcquirer(RULES, { description: '03999061714 PBB-PBCS AC 3', reference: '20260803000145' })?.acquirerCode).toBe('PBB');
    expect(recogniseAcquirer(RULES, { description: 'Book Transfer Third AEON CREDIT SERVICE', reference: 'MA458030287507' })?.acquirerCode).toBe('AEON');
    /* Hong Leong names the trading day in the REFERENCE, not the description —
       which is why the rules say which field to look in. */
    const hlb = recogniseAcquirer(RULES, { description: 'CA Credit Advice', reference: '00005992235 MERCHANT 20260616' });
    expect(hlb?.acquirerCode).toBe('HLB');
    expect(hlb?.tradingDate).toBe('2026-06-16');
  });

  it('says nothing about a line no rule claims', () => {
    expect(recogniseAcquirer(RULES, { description: 'CDM CASH DEPOSIT', reference: null })).toBeNull();
    expect(recogniseAcquirer(RULES, { description: 'LAU LEE YEN *', reference: 'Jaslyn' })).toBeNull();
  });

  /* A sixth bank is a config row, not a deploy — the rule the brief sets and
     the reason none of the four above is named in the code. */
  it('takes a bank it has never seen from the rules it is given', () => {
    const seen = recogniseAcquirer([{ acquirerCode: 'RHB', pattern: 'RHB MERCHANT SETTLEMENT' }],
      { description: 'RHB MERCHANT SETTLEMENT 0099', reference: null });
    expect(seen?.acquirerCode).toBe('RHB');
  });

  it('names the rule that carries a broken pattern instead of throwing anonymously', () => {
    expect(() => recogniseAcquirer([{ acquirerCode: 'BAD', pattern: '(unclosed' }], { description: 'x', reference: null }))
      .toThrow(/BAD/);
  });
});

/* ── Claiming a statement ─────────────────────────────────────────────────── */

const batch = (over: Partial<PayableBatch> = {}): PayableBatch => ({
  id: 1, acquirerCode: 'MBB', fileName: 'mbb-0731.csv',
  periodFrom: '2026-07-31', periodTo: '2026-07-31',
  payableSen: 728448, outstandingSen: 728448,
  ...over,
});

const decide = (over: Partial<BankLine>, batches: PayableBatch[]) =>
  matchBankMovements({ movements: groupBankMovements([line(over)]), rules: RULES, batches })[0]!;

describe('matching a credit to the statement it settles', () => {
  it('claims the one statement owed exactly this, on the day the bank names', () => {
    const d = decide({}, [batch()]);
    expect(d.kind).toBe('PAYOUT');
    expect(d.batchId).toBe(1);
    expect(d.clue).toMatch(/mbb-0731\.csv/);
    expect(d.clue).toMatch(/2026-07-31/);
  });

  /* The whole reason the charge is joined before matching: the batch expects
     the NET, and the credit alone is the gross. */
  it('matches a split payout on its net, not on the gross that arrived', () => {
    const movements = groupBankMovements([
      line({ amountSen: 87500, reference: 'D90200808', description: 'DR/CARD SALES M/N 2259020 DATED 08082026' }),
      line({ amountSen: -394, reference: 'D90200808', description: 'DR/CARD SALES M/N 2259020 DATED 08082026' }),
    ]);
    const d = matchBankMovements({
      movements, rules: RULES,
      batches: [batch({ id: 7, periodFrom: '2026-08-08', periodTo: '2026-08-08', payableSen: 87106, outstandingSen: 87106 })],
    })[0]!;
    expect(d.kind).toBe('PAYOUT');
    expect(d.batchId).toBe(7);
  });

  it('will not choose between two statements owed the same amount', () => {
    const d = decide({}, [batch({ id: 1 }), batch({ id: 2, fileName: 'other.csv' })]);
    expect(d.kind).toBe('PAYOUT_UNSURE');
    expect(d.candidates.map((b) => b.id)).toEqual([1, 2]);
    expect(d.clue).toMatch(/Pick the one/);
  });

  /* Both numbers in the sentence. A difference he can see is one he can
     explain; one he cannot see is one he approves blind. */
  it('names both amounts when the day agrees and the money does not', () => {
    const d = decide({}, [batch({ outstandingSen: 700000 })]);
    expect(d.kind).toBe('PAYOUT_UNSURE');
    expect(d.clue).toMatch(/RM 7,000\.00/);
    expect(d.clue).toMatch(/RM 7,284\.48/);
  });

  it('says so when the acquirer is known and nothing of theirs is waiting', () => {
    const d = decide({}, [batch({ acquirerCode: 'PBB' })]);
    expect(d.kind).toBe('PAYOUT_NO_BATCH');
    expect(d.clue).toMatch(/MBB paid RM 7,284\.48 for 2026-07-31/);
    expect(d.clue).toMatch(/Reconcile the merchant report first/);
  });

  it('ignores a statement that has already been paid in full', () => {
    const d = decide({}, [batch({ outstandingSen: 0 })]);
    expect(d.kind).toBe('PAYOUT_NO_BATCH');
  });

  it('leaves everything that is not an acquirer alone', () => {
    expect(decide({ description: 'CDM CASH DEPOSIT', reference: null }, [batch()]).kind).toBe('OTHER');
    expect(decide({ description: 'MBB TO HLBB BANK', reference: 'MPV-1' }, [batch()]).kind).toBe('OTHER');
  });

  /* An acquirer's own charge line reads exactly like its payout to a pattern;
     only the sign tells them apart, so the sign is tested first. */
  it('never reads money going OUT as an acquirer paying in', () => {
    const d = decide({ amountSen: -728448 }, [batch()]);
    expect(d.kind).toBe('OTHER');
    expect(d.batchId).toBeNull();
  });
});

/* ── The seeded rules must match the REAL statements ─────────────────────────
   The four rules ship in migration 0305, written from the owner's own files.
   A pattern that stops matching is silent — the money simply reads as
   "not a card payout" forever, which is the exact 系统3 disease the brief names.
   So the seed is read out of the migration and run against the real strings. */

describe('the recognition rules shipped in migration 0305', () => {
  const sql = readFileSync(
    new URL('../db/migrations-pg/0305_acc_bank_reconciliation.sql', import.meta.url),
    'utf8',
  );

  /* Pull the VALUES rows out of the seed: ('CODE', 'pattern', 'field', date, merchant, ord, */
  const seeded: BankRecognitionRule[] = [...sql.matchAll(
    /\n\s{2}\('([A-Z]+)',\s*'([^']*)',\s*'(description|reference|both)',\s*(NULL|'[^']*'),\s*(NULL|'[^']*')/g,
  )].map((m) => ({
    acquirerCode: m[1]!,
    pattern: m[2]!,
    field: m[3] as BankRecognitionRule['field'],
    tradingDatePattern: m[4] === 'NULL' ? null : m[4]!.slice(1, -1),
    merchantPattern: m[5] === 'NULL' ? null : m[5]!.slice(1, -1),
  }));

  it('seeds one rule for each acquirer whose money the real files carry', () => {
    expect(seeded.map((r) => r.acquirerCode)).toEqual(['MBB', 'PBB', 'AEON', 'HLB']);
  });

  /* Every string below is copied out of a real statement, character for
     character — Maybank's from ACCOUNTACTIVITYREPORT_564418610346.csv, Hong
     Leong's from account 23600602788. */
  const REAL: Array<{ desc: string; ref: string | null; who: string; day?: string; merchant?: string }> = [
    { desc: 'CR/CARD SALES MN 32410011 DATED 31072026', ref: '00113107', who: 'MBB', day: '2026-07-31', merchant: '32410011' },
    { desc: 'DR/CARD SALES M/N 2259020 DATED 08082026', ref: 'D90200808', who: 'MBB', day: '2026-08-08', merchant: '2259020' },
    { desc: '9205920432 CR/CARD SALES DATED 04082026', ref: '04320408', who: 'MBB', day: '2026-08-04' },
    { desc: '03999061714 PBB-PBCS AC 3', ref: '20260803000145', who: 'PBB' },
    { desc: 'Book Transfer Third AEON CREDIT SERVICE', ref: 'MA458030287507', who: 'AEON' },
    { desc: 'CA Credit Advice', ref: '00005992235  MERCHANT 20260616', who: 'HLB', day: '2026-06-16', merchant: '00005992235' },
  ];

  for (const c of REAL) {
    it(`recognises ${c.who} from "${c.desc.slice(0, 34)}"`, () => {
      const seen = recogniseAcquirer(seeded, { description: c.desc, reference: c.ref });
      expect(seen?.acquirerCode).toBe(c.who);
      if (c.day) expect(seen?.tradingDate).toBe(c.day);
      if (c.merchant) expect(seen?.merchantNo).toBe(c.merchant);
    });
  }

  /* And the money that is NOT a card payout stays not a card payout — a rule
     broad enough to swallow a customer transfer would reconcile it against a
     merchant statement and hide a real difference. */
  it('claims none of the ordinary banking around them', () => {
    for (const desc of ['CDM CASH DEPOSIT', 'MBB TO HLBB BANK', 'LAU LEE YEN *', 'MBB CT- HO KAI YIN *', 'HV-PV-202607-0178 HOUZS VENTURE HO']) {
      expect(recogniseAcquirer(seeded, { description: desc, reference: 'Fund Transfer' })).toBeNull();
    }
  });
});
