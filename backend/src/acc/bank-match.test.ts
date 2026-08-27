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


import { describe, it, expect } from 'vitest';
import {
  groupBankMovements, recogniseAcquirer, matchBankMovements, exactCombination,
  type BankRecognitionRule, type PayableBatch, type PayoutAdviceForMatch,
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


/* ── One credit, several statements ───────────────────────────────────────────
   Public Bank's real shape (migration 0335's header): one advice of 10 Aug pays
   for trading on the 7th, 8th and 9th. The owner raised the same shape one
   level down — 顾客可能刷一次卡，但是还两个单 — and the merchant side has handled
   it since layer 3; the bank side did not, and told the operator his credit was
   too big with no way to do the right thing. */

describe('a credit that pays more than one statement', () => {
  const owed = (id: number, sen: number, day: string): PayableBatch => ({
    id, acquirerCode: 'PBB', fileName: `pbb-${day}.csv`,
    periodFrom: day, periodTo: day, payableSen: sen, outstandingSen: sen,
  });

  it('finds the one set of statements that adds up', () => {
    const found = exactCombination(
      [owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08'), owed(3, 400000, '2026-08-09')],
      350000,
    );
    expect(found.map((b) => b.id)).toEqual([1, 2]);
  });

  it('takes three of them, which is what Public Bank actually pays', () => {
    const found = exactCombination(
      [owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08'), owed(3, 400000, '2026-08-09')],
      750000,
    );
    expect(found.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  /* "Some two of these four" is not an answer a person can check, so when more
     than one set adds up, nothing is suggested. Four statements of 1,000 /
     2,000 / 1,000 / 2,000 make 3,000 four different ways. */
  it('suggests nothing when more than one set adds up', () => {
    const found = exactCombination([
      owed(1, 100000, '2026-08-07'), owed(2, 200000, '2026-08-08'),
      owed(3, 100000, '2026-08-09'), owed(4, 200000, '2026-08-10'),
    ], 300000);
    expect(found).toEqual([]);
  });

  /* And the matcher turns that into a question rather than a silent nothing:
     the money IS a payout, it just cannot be allocated without a person. */
  it('leaves an ambiguous split to a person, still named as a payout', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([line({ amountSen: 300000, description: '03999061714 PBB-PBCS AC 3', reference: 'R' })]),
      rules: RULES,
      batches: [
        owed(1, 100000, '2026-08-07'), owed(2, 200000, '2026-08-08'),
        owed(3, 100000, '2026-08-09'), owed(4, 200000, '2026-08-10'),
      ],
    })[0]!;
    expect(d.kind).toBe('PAYOUT_UNSURE');
    expect(d.split).toEqual([]);
    expect(d.candidates).toHaveLength(4);
  });

  it('will not take a near miss', () => {
    expect(exactCombination([owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08')], 350001)).toEqual([]);
  });

  it('never answers with a single statement — that is the other branch', () => {
    expect(exactCombination([owed(1, 350000, '2026-08-07')], 350000)).toEqual([]);
  });

  it('routes the whole thing through the matcher, with the sum named', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([line({
        amountSen: 350000, description: '03999061714 PBB-PBCS AC 3', reference: '20260810000145',
      })]),
      rules: RULES,
      batches: [owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08'), owed(3, 900000, '2026-08-09')],
    })[0]!;

    expect(d.kind).toBe('PAYOUT_SPLIT');
    expect(d.split).toEqual([{ batchId: 1, amountSen: 100000 }, { batchId: 2, amountSen: 250000 }]);
    expect(d.clue).toMatch(/2 of PBB's reports add up to RM 3,500\.00 exactly/);
    expect(d.clue).toMatch(/pbb-2026-08-07\.csv RM 1,000\.00 \+ pbb-2026-08-08\.csv RM 2,500\.00/);
  });

  /* A single exact statement still wins: the cheapest true answer, not the
     most elaborate one. */
  it('prefers one statement owed exactly that over any combination', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([line({ amountSen: 350000, description: '03999061714 PBB-PBCS AC 3', reference: 'R' })]),
      rules: RULES,
      batches: [owed(9, 350000, '2026-08-10'), owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08')],
    })[0]!;
    expect(d.kind).toBe('PAYOUT');
    expect(d.batchId).toBe(9);
    expect(d.split).toEqual([]);
  });
});

/* ── The payment advice: the payer's own answer ───────────────────────────────
   Public Bank sends ONE IBG advice naming the settlement days a credit pays
   (acc/payout-advice). Where an uploaded advice answers for a credit, nothing
   is searched or inferred — and nothing is CAPPED: the combination search stops
   at four statements, which is the very limit the advice exists to remove. */

describe('a credit the payment advice answers for', () => {
  const owed = (id: number, sen: number, day: string): PayableBatch => ({
    id, acquirerCode: 'PBB', fileName: `pbb-${day}.csv`,
    periodFrom: day, periodTo: day, payableSen: sen, outstandingSen: sen,
  });

  /* Six days, six reports — beyond exactCombination's reach on purpose. */
  const SIX_DAYS = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'];
  const sixBatches = SIX_DAYS.map((day, i) => owed(i + 1, 100000 + i, day));
  const advice = (over: Partial<PayoutAdviceForMatch> = {}): PayoutAdviceForMatch => ({
    id: 51, acquirerCode: 'PBB', fileName: 'HOUZSCENTURY_IBG_100826.pdf',
    adviceDate: '2026-08-10',
    netSen: SIX_DAYS.reduce((s, _d, i) => s + 100000 + i, 0),
    days: SIX_DAYS.map((settledOn, i) => ({ settledOn, netSen: 100000 + i })),
    ...over,
  });
  const pbbCredit = (amountSen: number, bookedOn = '2026-08-10') =>
    line({ amountSen, bookedOn, description: '03999061714 PBB-PBCS AC 3', reference: '20260810000145' });

  it('allocates a payout across MORE reports than the search would ever try', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(advice().netSen)]),
      rules: RULES, batches: sixBatches, payouts: [advice()],
    })[0]!;
    expect(d.kind).toBe('PAYOUT_SPLIT');
    expect(d.split).toEqual(SIX_DAYS.map((_day, i) => ({ batchId: i + 1, amountSen: 100000 + i })));
    expect(d.clue).toMatch(/PBB's payment advice of 2026-08-10 says/);
    expect(d.clue).toMatch(/pays 6 reports/);
  });

  it('claims a single report by the advice, and says the advice said so', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(100000)]),
      rules: RULES,
      batches: [owed(1, 100000, '2026-08-07')],
      payouts: [advice({ netSen: 100000, days: [{ settledOn: '2026-08-07', netSen: 100000 }] })],
    })[0]!;
    expect(d.kind).toBe('PAYOUT');
    expect(d.batchId).toBe(1);
    expect(d.clue).toMatch(/payment advice of 2026-08-10 says this RM 1,000\.00 credit pays pbb-2026-08-07\.csv/);
  });

  /* One report can span two of the advice's days; its shares are summed, not
     offered twice — the same report booked twice would double the money. */
  it('adds up the advice days that fall inside one report', () => {
    const spanning: PayableBatch = {
      id: 4, acquirerCode: 'PBB', fileName: 'pbb-weekend.csv',
      periodFrom: '2026-08-07', periodTo: '2026-08-08', payableSen: 350000, outstandingSen: 350000,
    };
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(350000)]),
      rules: RULES, batches: [spanning],
      payouts: [advice({
        netSen: 350000,
        days: [{ settledOn: '2026-08-07', netSen: 100000 }, { settledOn: '2026-08-08', netSen: 250000 }],
      })],
    })[0]!;
    expect(d.kind).toBe('PAYOUT');
    expect(d.batchId).toBe(4);
  });

  /* The advice outranks the amount coincidence: a lone report owed exactly the
     credit must not beat the payer's own written allocation. */
  it('believes the advice over a single report owed the same amount', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(350000)]),
      rules: RULES,
      batches: [owed(9, 350000, '2026-08-10'), owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08')],
      payouts: [advice({
        netSen: 350000,
        days: [{ settledOn: '2026-08-07', netSen: 100000 }, { settledOn: '2026-08-08', netSen: 250000 }],
      })],
    })[0]!;
    expect(d.kind).toBe('PAYOUT_SPLIT');
    expect(d.split).toEqual([{ batchId: 1, amountSen: 100000 }, { batchId: 2, amountSen: 250000 }]);
    expect(d.clue).toMatch(/payment advice/);
  });

  /* An advice naming a day with no reconciled report is HISTORY, not an answer
     — the ordinary outcome says what a person has to do first. */
  it('falls back to the search when a day the advice names has no report waiting', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(350000)]),
      rules: RULES,
      batches: [owed(1, 100000, '2026-08-07')],   // the 08-08 report is not reconciled yet
      payouts: [advice({
        netSen: 350000,
        days: [{ settledOn: '2026-08-07', netSen: 100000 }, { settledOn: '2026-08-08', netSen: 250000 }],
      })],
    })[0]!;
    expect(d.kind).toBe('PAYOUT_UNSURE');
    expect(d.clue).toMatch(/no single report/);
  });

  /* A report partly paid since the advice was written no longer answers to it:
     booking the advice's figure would book money that already arrived. */
  it('falls back when a report has been partly paid since the advice was written', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(350000)]),
      rules: RULES,
      batches: [
        { ...owed(1, 100000, '2026-08-07'), outstandingSen: 60000 },
        owed(2, 250000, '2026-08-08'),
      ],
      payouts: [advice({
        netSen: 350000,
        days: [{ settledOn: '2026-08-07', netSen: 100000 }, { settledOn: '2026-08-08', netSen: 250000 }],
      })],
    })[0]!;
    expect(d.kind).toBe('PAYOUT_UNSURE');
  });

  it('ignores another acquirer’s advice, whatever its amount', () => {
    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(100000)]),
      rules: RULES,
      batches: [owed(1, 100000, '2026-08-07')],
      payouts: [advice({ acquirerCode: 'MBB', netSen: 100000, days: [{ settledOn: '2026-08-07', netSen: 100000 }] })],
    })[0]!;
    /* Still matched — by the ordinary exact-amount path, not the advice. */
    expect(d.kind).toBe('PAYOUT');
    expect(d.clue).not.toMatch(/advice/);
  });

  /* Two advices for the same amount: the credit's own day picks one, and when
     it cannot, nothing does — "some advice or other" is not an answer. */
  it('tells two same-amount advices apart by the day the credit landed', () => {
    const twoOfEach = [
      owed(1, 100000, '2026-08-07'), owed(2, 250000, '2026-08-08'),
      owed(3, 100000, '2026-09-07'), owed(4, 250000, '2026-09-08'),
    ];
    const august = advice({
      id: 51, adviceDate: '2026-08-10', netSen: 350000,
      days: [{ settledOn: '2026-08-07', netSen: 100000 }, { settledOn: '2026-08-08', netSen: 250000 }],
    });
    const september = advice({
      id: 52, adviceDate: '2026-09-10', netSen: 350000,
      days: [{ settledOn: '2026-09-07', netSen: 100000 }, { settledOn: '2026-09-08', netSen: 250000 }],
    });

    const d = matchBankMovements({
      movements: groupBankMovements([pbbCredit(350000, '2026-09-10')]),
      rules: RULES, batches: twoOfEach, payouts: [august, september],
    })[0]!;
    expect(d.kind).toBe('PAYOUT_SPLIT');
    expect(d.split).toEqual([{ batchId: 3, amountSen: 100000 }, { batchId: 4, amountSen: 250000 }]);

    /* A credit on a day NEITHER advice names decides nothing. Both sets of
       reports also add up, so the combination search is ambiguous too, and the
       whole thing lands with a person — which is the honest outcome. */
    const undecided = matchBankMovements({
      movements: groupBankMovements([pbbCredit(350000, '2026-09-12')]),
      rules: RULES, batches: twoOfEach, payouts: [august, september],
    })[0]!;
    expect(undecided.kind).toBe('PAYOUT_UNSURE');
  });
});
