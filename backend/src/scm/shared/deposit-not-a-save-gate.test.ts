// ----------------------------------------------------------------------------
// THE DEPOSIT IS NOT A SAVE GATE — owner ruling, 2026-08-20.
//
// His words: 「以电脑为准 —— 两边都不查」 — the desktop is the standard, and
// NEITHER side checks. Until that ruling the money condition was enforced by
// surface rather than by rule: the desktop New-SO screen sent a bare
// `manualEntry: true` on every create and had the condition dropped for it,
// while the phone sent nothing and was refused the very same order. The edit
// path waived nothing at all, so a desktop-created RM 0 order was accepted at
// create and then refused the moment anyone RESCHEDULED it — a header PATCH
// that sets or changes the Processing Date — with no hint why the save had
// worked the day before. Four live paths applied the condition in total: create,
// header edit, /status proceed, and amendment approve.
//
// This file replaces manual-entry-deposit-waiver.test.ts, whose subject — the
// waiver — no longer exists. There is nothing to waive: the condition is gone
// from the collector that decides it, so every surface gets the same answer
// from one place.
//
// It is a POLICY change, not a bug fix. What it must not become is a quiet
// loosening of the OTHER four conditions, so those are asserted here too: an
// order still cannot be released for purchasing without a customer, an address,
// a postcode and a delivery date. Purchasing ordering goods for an address
// nobody has is a different failure from an unpaid deposit, and the owner
// removed only the second one.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { collectProcessingGateProblems, type ProcessingGateFacts } from './so-save-problems';

/** An order released for ordering, fully addressed, with NOTHING paid. */
const facts = (over: Partial<ProcessingGateFacts> = {}): ProcessingGateFacts => ({
  procDate: '2026-09-01',
  delivDate: '2026-09-20',
  todayMY: '2026-08-18',
  completeness: { hasCustomerName: true, hasAddress: true, hasPostcode: true },
  ...over,
});

const codes = (o: ProcessingGateFacts): string[] =>
  collectProcessingGateProblems(o).map((p) => p.code);

describe('the deposit never blocks a save (owner 2026-08-20)', () => {
  test('a Processing Date on a wholly unpaid order raises nothing', () => {
    expect(collectProcessingGateProblems(facts())).toEqual([]);
  });

  /* THE RED ONE. The cast is the whole point of this test: it hands the
     collector exactly the shape the create and edit paths used to pass. Before
     the ruling that produced `processing_date_unpaid`; after it, the condition
     is GONE rather than merely unfed, so no caller can put the refusal back by
     supplying the facts again. A test that simply omitted the key would have
     passed before the change too, and proved nothing. */
  test('no caller can restore the refusal by handing over deposit facts', () => {
    const withDepositFacts = {
      ...facts(),
      deposit: { paidSen: 0, totalSen: 500_000 },
    } as ProcessingGateFacts;
    expect(codes(withDepositFacts)).not.toContain('processing_date_unpaid');
    expect(collectProcessingGateProblems(withDepositFacts)).toEqual([]);
  });

  /* The threshold used to be per company (Houzs 30%, 2990 50%), which is why
     ProcessingGateFacts carried a companyCode at all. Nothing here reads a
     company any more — the gate cannot give two companies different answers
     about the money because it gives neither an answer. */
  test('the gate takes no company code — there is no per-company money rule left', () => {
    expect(Object.keys(facts())).not.toContain('companyCode');
  });

  /* The ruling is ONE condition. These four still refuse — an order nobody can
     deliver must not reach purchasing just because the money stopped counting. */
  test('customer / address / postcode still refuse', () => {
    const problems = codes(facts({
      completeness: { hasCustomerName: false, hasAddress: false, hasPostcode: false },
    }));
    expect(problems.filter((c) => c === 'processing_date_incomplete')).toHaveLength(3);
  });

  test('a missing delivery date still refuses', () => {
    expect(codes(facts({ delivDate: null }))).toContain('processing_date_incomplete');
  });

  test('the date rules still refuse', () => {
    expect(codes(facts({ procDate: '2026-09-25' }))).toContain('processing_after_delivery');
    expect(codes(facts({ procDate: '2026-08-01' }))).toContain('processing_date_past');
  });
});
