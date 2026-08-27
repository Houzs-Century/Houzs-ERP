// What this file pins — the four rules 系统3 got wrong:
//   1. ONLY a unique reference may auto-match. No unique ref (or an acquirer
//      whose 决定4 config is still blank) ⇒ every line waits for a human.
//   2. The date tolerance comes from the config row, not from a literal in the
//      code (系统3's document said 3 days, its code said 7).
//   3. One settlement can cover several orders — the pairs that add up are
//      pointed at, not left for the operator to find.
//   4. Money already cleared by another line is never offered again.

import { describe, it, expect } from 'vitest';
import { matchStatement, recordedNotArrived, type PaymentCandidate, type MatchConfig } from './settlement-match';
import type { ParsedRow } from './settlement-parse';

const row = (over: Partial<ParsedRow> = {}): ParsedRow => ({
  lineNo: 2, txnDate: '2026-08-03', ref: 'A1', grossSen: 100000, feeSen: 1500, netSen: 98500, ...over,
});

const pay = (over: Partial<PaymentCandidate> = {}): PaymentCandidate => ({
  source: 'SOPAY', id: 'p1', docNo: 'SO-2608-001', paidOn: '2026-08-01',
  amountSen: 100000, approvalCode: 'A1', customerName: null, ...over,
});

const cfg = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  code: 'MBB', has_unique_ref: true, date_tolerance_days: 3, ...over,
});

describe('the unique reference is the only automatic path', () => {
  it('one payment carrying the reference auto-matches, and says why', () => {
    const [d] = matchStatement(cfg(), [row()], [pay()]);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matchReason).toBe('ref');
    expect(d.matched.map((p) => p.id)).toEqual(['p1']);
    expect(d.clue).toMatch(/SO-2608-001/);
  });

  it('leading zeros and case do not hide a reference from itself', () => {
    const [d] = matchStatement(cfg(), [row({ ref: '00123' })], [pay({ approvalCode: '123' })]);
    expect(d.bucket).toBe('MATCHED');
  });

  it('an acquirer WITHOUT a unique reference never auto-confirms — the GHL rule', () => {
    const [d] = matchStatement(cfg({ code: 'GHL', has_unique_ref: false }), [row()], [pay()]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
    expect(d.matched).toHaveLength(0);
    expect(d.candidates.map((p) => p.id)).toEqual(['p1']);
    expect(d.clue).toMatch(/no unique reference/i);
  });

  it('an acquirer whose config is still blank counts as "no unique reference"', () => {
    const [d] = matchStatement(cfg({ has_unique_ref: null }), [row()], [pay()]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
  });

  /* Two payments of the same amount on the same day is a QUESTION. Ticking one
     of them for him would be the system guessing with his money. */
  it('two payments on the same amount and date are offered but never pre-ticked', () => {
    const [d] = matchStatement(cfg(), [row({ ref: 'ZZZ' })], [
      pay({ approvalCode: 'A9' }),
      pay({ id: 'p2', docNo: 'SO-2608-002', approvalCode: 'B8' }),
    ]);
    expect(d.candidates).toHaveLength(2);
    expect(d.suggested).toHaveLength(0);
    expect(d.clue).toMatch(/pick the right one/);
  });

  it('two payments sharing a reference is a question, not a guess', () => {
    const [d] = matchStatement(cfg(), [row()], [pay(), pay({ id: 'p2', docNo: 'SO-2608-002' })]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
    expect(d.candidates).toHaveLength(2);
  });

  /* The owner cannot guarantee the approval code was typed correctly (2026-08-18:
     我没办法确定 authorised code salesperson 一定填对), so a reference that hits
     nothing must not become 'no payment recorded' — it falls through to amount
     and date, and when there is exactly ONE the system offers it, pre-ticked,
     for a human to confirm. Offered, never taken. */
  it('a reference that matches nothing falls through to amount+date, and the single answer is offered', () => {
    const [d] = matchStatement(cfg(), [row({ ref: 'ZZZ' })], [pay({ approvalCode: 'A9' })]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
    expect(d.matchReason).toBe('amount+date');
    expect(d.suggested.map((p) => p.docNo)).toEqual(['SO-2608-001']);
    expect(d.matched).toHaveLength(0);            // suggested is not taken
    expect(d.clue).toMatch(/Reference ZZZ matched nothing/);
    expect(d.clue).toMatch(/Check it and confirm/);
  });
});

describe('the date tolerance is the configured number', () => {
  it('3 days accepts day 3 and refuses day 4', () => {
    const inside = matchStatement(cfg({ has_unique_ref: false }), [row({ txnDate: '2026-08-04' })], [pay({ paidOn: '2026-08-01' })]);
    expect(inside[0].bucket).toBe('NEEDS_CONFIRM');

    const outside = matchStatement(cfg({ has_unique_ref: false }), [row({ txnDate: '2026-08-05' })], [pay({ paidOn: '2026-08-01' })]);
    expect(outside[0].bucket).toBe('UNMATCHED');
  });

  it('a wider tolerance in the config widens the window, with no code change', () => {
    const [d] = matchStatement(cfg({ has_unique_ref: false, date_tolerance_days: 7 }), [row({ txnDate: '2026-08-07' })], [pay({ paidOn: '2026-08-01' })]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
  });
});

describe('one swipe, several orders', () => {
  it('points at the pair that adds up exactly', () => {
    const [d] = matchStatement(
      cfg({ has_unique_ref: false }),
      [row({ grossSen: 150000, ref: null })],
      [pay({ id: 'a', amountSen: 100000 }), pay({ id: 'b', amountSen: 50000 }), pay({ id: 'c', amountSen: 30000 })],
    );
    expect(d.bucket).toBe('NEEDS_CONFIRM');
    expect(d.comboHints).toContainEqual(['a', 'b']);
    expect(d.clue).toMatch(/add up/);
  });
});

describe('money is only ever settled once', () => {
  it('a payment cleared by an earlier statement is not offered again', () => {
    const settled = new Set(['SOPAY:p1']);
    const [d] = matchStatement(cfg(), [row()], [pay()], settled);
    expect(d.bucket).toBe('UNMATCHED');
    expect(d.candidates).toHaveLength(0);
  });

  it('two lines of the SAME file cannot both take the same payment', () => {
    const [first, second] = matchStatement(cfg(), [row({ lineNo: 2 }), row({ lineNo: 3 })], [pay()]);
    expect(first.bucket).toBe('MATCHED');
    expect(second.bucket).toBe('UNMATCHED');
  });
});

describe('watchlist 1 — recorded, not arrived', () => {
  it('lists unsettled payments oldest first, with their age', () => {
    const list = recordedNotArrived(
      [pay({ id: 'old', paidOn: '2026-07-20' }), pay({ id: 'new', paidOn: '2026-08-14' }), pay({ id: 'done' })],
      new Set(['SOPAY:done']),
      '2026-08-16',
    );
    expect(list.map((p) => p.id)).toEqual(['old', 'new']);
    expect(list[0].ageDays).toBe(27);
  });
});

/* 顾客可能刷一次卡，但是还两个单 (owner, 2026-08-20). Two was always suggested;
   three worked only if the operator found it himself, because the hint looked
   for pairs and nothing else. Both are the same act. */
describe('one swipe settling several orders', () => {
  const pay = (id: string, sen: number): PaymentCandidate =>
    ({ source: 'SOPAY', id, docNo: `SO-${id}`, paidOn: '2026-08-01', amountSen: sen, approvalCode: null, customerName: null });

  const line = (grossSen: number) => matchStatement(
    { code: 'GHL', has_unique_ref: false, date_tolerance_days: 3 },
    [{ lineNo: 1, txnDate: '2026-08-01', ref: null, grossSen, feeSen: 0, netSen: grossSen }],
    [pay('a', 60000), pay('b', 40000), pay('c', 25000), pay('d', 15000)],
    new Set<string>(),
  )[0]!;

  it('points at the pair that adds up', () => {
    expect(line(100000).comboHints).toContainEqual(['a', 'b']);
  });

  it('points at the THREE that add up, which used to be invisible', () => {
    const d = line(125000);
    expect(d.comboHints).toContainEqual(['a', 'b', 'c']);
  });

  it('takes four when four is the answer', () => {
    expect(line(140000).comboHints).toContainEqual(['a', 'b', 'c', 'd']);
  });

  it('offers nothing at all when nothing adds up', () => {
    expect(line(123456).comboHints).toEqual([]);
  });

  /* A screen offering more possibilities than a person can weigh is not
     helping, so the list is capped rather than exhaustive. */
  it('stops at five suggestions', () => {
    const many = Array.from({ length: 10 }, (_, i) => pay(`p${i}`, 10000));
    const d = matchStatement(
      { code: 'GHL', has_unique_ref: false, date_tolerance_days: 3 },
      [{ lineNo: 1, txnDate: '2026-08-01', ref: null, grossSen: 20000, feeSen: 0, netSen: 20000 }],
      many, new Set<string>(),
    )[0]!;
    expect(d.comboHints.length).toBeLessThanOrEqual(5);
    expect(d.comboHints.length).toBeGreaterThan(0);
  });
});

/* A set that adds up ONE way is an answer whatever its size — the pre-tick used
   to require exactly two documents, so a customer settling three orders with one
   swipe was found and then not offered. */
describe('pre-ticking the set that adds up', () => {
  const pay = (id: string, sen: number): PaymentCandidate =>
    ({ source: 'SOPAY', id, docNo: `SO-${id}`, paidOn: '2026-08-01', amountSen: sen, approvalCode: null, customerName: null });

  const decide = (grossSen: number, pool: PaymentCandidate[]) => matchStatement(
    { code: 'GHL', has_unique_ref: false, date_tolerance_days: 3 },
    [{ lineNo: 1, txnDate: '2026-08-01', ref: null, grossSen, feeSen: 0, netSen: grossSen }],
    pool, new Set<string>(),
  )[0]!;

  it('ticks two when two is the only way', () => {
    const d = decide(100000, [pay('a', 60000), pay('b', 40000), pay('c', 33000)]);
    expect(d.suggested?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(d.clue).toMatch(/SO-a \+ SO-b add up to it exactly/);
  });

  it('ticks THREE when three is the only way', () => {
    const d = decide(125000, [pay('a', 60000), pay('b', 40000), pay('c', 25000)]);
    expect(d.suggested?.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(d.clue).toMatch(/add up to it exactly/);
  });

  /* Two ways to make the amount is a question. Nothing is ticked, and the
     screen says how many ways there are rather than picking one. */
  it('ticks nothing when the amount can be made two ways', () => {
    const d = decide(100000, [pay('a', 60000), pay('b', 40000), pay('c', 60000), pay('d', 40000)]);
    expect(d.suggested).toEqual([]);
    expect(d.clue).toMatch(/set\(s\) of payments add up to this amount — pick the right one/);
  });
});

/* 多张 so 那边放的 approval code 都一样，然后加起来金额是对的上卡机报告的，你不能
   自动核对吗 (owner, 2026-08-20). He is right: one reference shared by several
   payments that add up to the line exactly is one swipe the till split across
   documents — the strongest evidence this module ever gets, and it used to be
   sent to a human as "pick the right one", asking him to choose between things
   that are not alternatives. */
describe('one swipe, one reference, several documents', () => {
  const pay = (id: string, sen: number, code: string | null): PaymentCandidate =>
    ({ source: 'SOPAY', id, docNo: `SO-${id}`, paidOn: '2026-08-01', amountSen: sen, approvalCode: code, customerName: null });

  const decide = (grossSen: number, pool: PaymentCandidate[], ref = 'A123') => matchStatement(
    { code: 'MBB', has_unique_ref: true, date_tolerance_days: 3 },
    [{ lineNo: 1, txnDate: '2026-08-01', ref, grossSen, feeSen: 0, netSen: grossSen }],
    pool, new Set<string>(),
  )[0]!;

  it('auto-matches when they carry the same code and add up exactly', () => {
    const d = decide(125000, [pay('a', 80000, 'A123'), pay('b', 45000, 'A123')]);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matchReason).toBe('ref');
    expect(d.matched.map((p) => p.id)).toEqual(['a', 'b']);
    expect(d.clue).toMatch(/matches 2 payments that add up to it exactly/);
    expect(d.clue).toMatch(/SO-a \+ SO-b/);
  });

  it('takes three the same way', () => {
    const d = decide(150000, [pay('a', 80000, 'A123'), pay('b', 45000, 'A123'), pay('c', 25000, 'A123')]);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matched).toHaveLength(3);
  });

  /* The owner, when this used to insist that ALL of them add up: 这个情况当他对
     的上卡机报告的数额也不应该出现不是? He is right. The usual cause of an extra
     payment wearing this reference is a code mis-keyed onto an unrelated sale,
     and the documents that add up ARE the swipe. */
  it('takes the ones that add up and leaves the odd one out, saying so', () => {
    const d = decide(125000, [pay('a', 80000, 'A123'), pay('b', 45000, 'A123'), pay('c', 30000, 'A123')]);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matched.map((p) => p.id)).toEqual(['a', 'b']);
    expect(d.clue).toMatch(/1 other payment\(s\) carry this reference and are not part of it — they stay open/);
  });

  /* And the one left behind is not swept away: it is unsettled, so it shows on
     the watchlist, which is exactly where a mis-keyed code should surface. */
  it('leaves the odd one unclaimed, so the watchlist can carry it', () => {
    const pool = [pay('a', 80000, 'A123'), pay('b', 45000, 'A123'), pay('c', 30000, 'A123')];
    const d = decide(125000, pool);
    const taken = new Set(d.matched.map((p) => `SOPAY:${p.id}`));
    expect(recordedNotArrived(pool, taken, '2026-08-05').map((p) => p.id)).toEqual(['c']);
  });

  /* One payment among them making the amount by itself is still one way. */
  it('takes a single payment when that is what adds up', () => {
    const d = decide(125000, [pay('a', 125000, 'A123'), pay('b', 30000, 'A123')]);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matched.map((p) => p.id)).toEqual(['a']);
  });

  /* TWO ways to make it is a question no evidence here can answer: 700 + 550
     + 550 against a line of 1,250 — which 550 was on the swipe? */
  it('asks when the amount can be made two ways', () => {
    const d = decide(125000, [pay('a', 70000, 'A123'), pay('b', 55000, 'A123'), pay('c', 55000, 'A123')]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
    expect(d.comboHints.length).toBeGreaterThan(1);
  });

  it('asks when no combination of them makes the line, naming both totals', () => {
    const d = decide(125000, [pay('a', 80000, 'A123'), pay('b', 30000, 'A123')]);
    expect(d.bucket).toBe('NEEDS_CONFIRM');
    expect(d.clue).toMatch(/no combination of them makes 1250\.00 \(they come to 1100\.00\)/);
  });

  /* The claim is on all of them: a second line of the same file must not take
     a payment this one already used. */
  it('claims every payment it took', () => {
    const ds = matchStatement(
      { code: 'MBB', has_unique_ref: true, date_tolerance_days: 3 },
      [
        { lineNo: 1, txnDate: '2026-08-01', ref: 'A123', grossSen: 125000, feeSen: 0, netSen: 125000 },
        { lineNo: 2, txnDate: '2026-08-01', ref: 'A123', grossSen: 125000, feeSen: 0, netSen: 125000 },
      ],
      [pay('a', 80000, 'A123'), pay('b', 45000, 'A123')],
      new Set<string>(),
    );
    expect(ds[0]!.bucket).toBe('MATCHED');
    expect(ds[1]!.bucket).not.toBe('MATCHED');
  });

  /* An acquirer that sends no unique reference may never auto-match, whatever
     the till happened to key in — the brief forbids it outright. */
  it('never auto-matches for an acquirer with no unique reference', () => {
    const d = matchStatement(
      { code: 'GHL', has_unique_ref: false, date_tolerance_days: 3 },
      [{ lineNo: 1, txnDate: '2026-08-01', ref: 'A123', grossSen: 125000, feeSen: 0, netSen: 125000 }],
      [pay('a', 80000, 'A123'), pay('b', 45000, 'A123')],
      new Set<string>(),
    )[0]!;
    expect(d.bucket).toBe('NEEDS_CONFIRM');
  });
});

/* 他可能不止两张单加起来，可能超过两张 (owner, 2026-08-20). There is no ceiling
   on how many documents one swipe covers, so there must be none in the matcher
   either — a cap would fail silently, telling the operator to "pick the right
   one" and giving him no reason why. */
describe('a swipe covering many documents', () => {
  const pay = (id: string, sen: number, code: string | null = 'A123'): PaymentCandidate =>
    ({ source: 'SOPAY', id, docNo: `SO-${id}`, paidOn: '2026-08-01', amountSen: sen, approvalCode: code, customerName: null });

  const byRef = (grossSen: number, pool: PaymentCandidate[]) => matchStatement(
    { code: 'MBB', has_unique_ref: true, date_tolerance_days: 3 },
    [{ lineNo: 1, txnDate: '2026-08-01', ref: 'A123', grossSen, feeSen: 0, netSen: grossSen }],
    pool, new Set<string>(),
  )[0]!;

  it('auto-matches six documents on one code', () => {
    const six = [pay('a', 10000), pay('b', 20000), pay('c', 30000), pay('d', 40000), pay('e', 50000), pay('f', 60000)];
    const d = byRef(210000, six);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matched).toHaveLength(6);
  });

  it('auto-matches ten', () => {
    const ten = Array.from({ length: 10 }, (_, i) => pay(`p${i}`, 10000 + i * 1000));
    const d = byRef(ten.reduce((s, p) => s + p.amountSen, 0), ten);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matched).toHaveLength(10);
  });

  /* And still finds the subset when one of many carries a mis-keyed code. */
  it('picks five out of six when the sixth is not part of it', () => {
    const d = byRef(150000, [
      pay('a', 10000), pay('b', 20000), pay('c', 30000),
      pay('d', 40000), pay('e', 50000), pay('odd', 7700),
    ]);
    expect(d.bucket).toBe('MATCHED');
    expect(d.matched.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(d.clue).toMatch(/1 other payment\(s\)/);
  });

  /* The amount-only path is deliberately shallower — see the comment on
     exactPairs — but it reaches well past two. */
  it('hints at five documents when the code matched nothing', () => {
    const d = matchStatement(
      { code: 'GHL', has_unique_ref: false, date_tolerance_days: 3 },
      [{ lineNo: 1, txnDate: '2026-08-01', ref: null, grossSen: 150000, feeSen: 0, netSen: 150000 }],
      [pay('a', 10000, null), pay('b', 20000, null), pay('c', 30000, null), pay('d', 40000, null), pay('e', 50000, null)],
      new Set<string>(),
    )[0]!;
    /* Largest first — that branch offers the window sorted by amount, which is
       the order a person reads a list of candidates in. */
    expect([...(d.suggested ?? [])].map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
