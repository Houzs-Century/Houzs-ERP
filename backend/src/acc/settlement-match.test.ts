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
    ({ source: 'SOPAY', id, docNo: `SO-${id}`, paidOn: '2026-08-01', amountSen: sen, approvalCode: null });

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
    ({ source: 'SOPAY', id, docNo: `SO-${id}`, paidOn: '2026-08-01', amountSen: sen, approvalCode: null });

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
