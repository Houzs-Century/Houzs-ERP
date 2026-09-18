/* The SO list's Approval Code column and its search (docs/bugs/0909): what a
   page of payment rows becomes per order, and the one `.or()` term the search
   adds. Both pure; the route's wiring of them is pinned by
   tests/soListApprovalCode.test.ts. */
import { describe, expect, it } from 'vitest';
import { approvalCodeOrPart, approvalCodesByOrder, type PaymentCodeRow } from './so-list-approval-codes';

const pay = (doc: string, code: string | null, paidAt: string, createdAt = `${paidAt}T03:00:00Z`): PaymentCodeRow =>
  ({ so_doc_no: doc, approval_code: code, paid_at: paidAt, created_at: createdAt });

describe('approvalCodesByOrder', () => {
  it('lists every code of an order in the order the money was paid, joined " + "', () => {
    const codes = approvalCodesByOrder([
      pay('2990-SO-2608-001', '001122', '2026-08-20'),
      pay('2990-SO-2608-001', '000384', '2026-08-08'),
    ]);
    expect(codes.get('2990-SO-2608-001')).toBe('000384 + 001122');
  });

  it('two payments on the same day keep the order they were keyed in', () => {
    const codes = approvalCodesByOrder([
      pay('SO-1', 'B', '2026-08-08', '2026-08-08T05:00:00Z'),
      pay('SO-1', 'A', '2026-08-08', '2026-08-08T04:00:00Z'),
    ]);
    expect(codes.get('SO-1')).toBe('A + B');
  });

  it('cash and online payments, which carry no code, contribute nothing — and an order with none is absent', () => {
    const codes = approvalCodesByOrder([
      pay('SO-1', null, '2026-08-08'),
      pay('SO-1', '  ', '2026-08-09'),
      pay('SO-2', ' 778899 ', '2026-08-09'),
    ]);
    expect(codes.has('SO-1')).toBe(false);
    expect(codes.get('SO-2')).toBe('778899');
  });

  it('an empty page is an empty map', () => {
    expect(approvalCodesByOrder([]).size).toBe(0);
  });
});

describe('approvalCodeOrPart', () => {
  it('names the orders in a double-quoted in-list, each once', () => {
    expect(approvalCodeOrPart(['2990-SO-2608-001', '2990-SO-2608-001', '2990-SO-2607-019']))
      .toBe('doc_no.in.("2990-SO-2608-001","2990-SO-2607-019")');
  });

  /* An empty in-list is a PostgREST syntax error, and a term admitting nothing
     must not ride the `.or()` at all. */
  it('is null when no payment matched, so nothing is sent', () => {
    expect(approvalCodeOrPart([])).toBeNull();
    expect(approvalCodeOrPart(['', '  '])).toBeNull();
  });

  it('never lets a quote in a doc number break the list', () => {
    expect(approvalCodeOrPart(['SO-"1'])).toBe('doc_no.in.("SO-1")');
  });
});
