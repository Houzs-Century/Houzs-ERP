// ----------------------------------------------------------------------------
// manualEntry waives the DEPOSIT condition — and nothing else.
//
// The hand-keyed New-SO screen writes an order up for a customer who has not
// paid yet, and it still has to carry a Processing Date so purchasing can order
// against it. So that path passes `deposit: null`, the same way the consignment
// mirror does (ProcessingGateFacts.deposit: "Omit / null when the gate doesn't
// apply on this path").
//
// The risk this file exists for is SCOPE CREEP, in both directions: a waiver
// that quietly drops the other four conditions would release an order nobody
// can deliver, and a later edit that reads `deposit: null` as "unpaid" would
// put the refusal back and re-break the screen. Both are asserted.
//
// Pure-function level. The wiring — that the create route passes null only when
// the client sent `manualEntry: true` — is asserted in
// tests/manualEntryDepositWaiverWiring.test.ts.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { collectProcessingGateProblems } from './so-save-problems';

/** An order released for ordering, fully addressed, with NOTHING paid. */
const facts = (over: Partial<Parameters<typeof collectProcessingGateProblems>[0]> = {}) => ({
  companyCode: '2990',
  procDate: '2026-09-01',
  delivDate: '2026-09-20',
  todayMY: '2026-08-18',
  completeness: { hasCustomerName: true, hasAddress: true, hasPostcode: true },
  deposit: { paidCenti: 0, totalCenti: 500_000 },
  ...over,
});

const codes = (o: Parameters<typeof collectProcessingGateProblems>[0]) =>
  collectProcessingGateProblems(o).map((p) => p.code);

describe('manualEntry deposit waiver', () => {
  test('without the waiver, a Processing Date on an unpaid order is refused', () => {
    expect(codes(facts())).toContain('processing_date_unpaid');
  });

  test('deposit: null clears that refusal — the hand-keyed path', () => {
    expect(codes(facts({ deposit: null }))).not.toContain('processing_date_unpaid');
    expect(collectProcessingGateProblems(facts({ deposit: null }))).toEqual([]);
  });

  /* The waiver is ONE condition. An order with no address still cannot be
     released, or purchasing orders goods for somewhere nobody can deliver. */
  test('the other conditions still refuse a hand-keyed order', () => {
    const problems = codes(facts({
      deposit: null,
      completeness: { hasCustomerName: true, hasAddress: false, hasPostcode: false },
    }));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).not.toContain('processing_date_unpaid');
  });

  /* A free order was already exempt before any of this (meetsDepositGate is
     vacuously true at total <= 0). The waiver must not be what makes that work,
     or removing it later would silently break zero-total orders. */
  test('a zero-total order needs no waiver to pass', () => {
    expect(codes(facts({ deposit: { paidCenti: 0, totalCenti: 0 } }))).not.toContain('processing_date_unpaid');
  });
});
