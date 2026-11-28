/* backfill-deposit-invoice-cost.mjs's own logic (owner 2026-11-26: deposit
   invoices book 34% as cost, 「记」). Made-up figures. Pinned: the cost one
   invoice books, the plan's id, and the shape an invoice posted again with its
   cost must have when read back. */

import { describe, expect, test } from 'vitest';
import { costOf, planId, repostProblems } from '../scripts/lib/deposit-invoice-cost-backfill.mjs';

const ROLES = { AR: '300-0000', DEPOSIT_INCOME: '509-0000', DEPOSIT_COST: '619-0000', DEPOSIT_COST_ACCRUAL: '410-0080' };

describe('costOf and planId', () => {
  test('the cost is the share of the deposit in whole sen', () => {
    expect(costOf(100_000, 34)).toBe(34_000);
    expect(costOf(12_345, 34)).toBe(4_197);
  });
  test('the same invoices give the same id in any order; another share, amount or entry is another plan', () => {
    const a = [{ di_number: 'HC-DI-2609-001', amount_sen: 100_000, je_no: 'JE-1' }, { di_number: 'HC-DI-2609-002', amount_sen: 50_000, je_no: 'JE-2' }];
    expect(planId(34, [...a].reverse())).toBe(planId(34, a));
    expect(planId(34, a)).toMatch(/^[0-9a-f]{12}$/);
    expect(planId(35, a)).not.toBe(planId(34, a));
    expect(planId(34, [{ ...a[0], amount_sen: 100_001 }, a[1]])).not.toBe(planId(34, a));
    expect(planId(34, [{ ...a[0], je_no: 'JE-9' }, a[1]])).not.toBe(planId(34, a));
  });
});

describe('repostProblems', () => {
  const di = { di_number: 'HC-DI-2609-001', amount_sen: 100_000, cost_sen: 34_000, je_no: 'JE-9', invoice_date: '2026-09-02', party_code: '300-C002' };
  const entries = [
    { id: 'e1', je_no: 'JE-1', source_type: 'DI', source_doc_no: 'HC-DI-2609-001', reversed: true, posted: true, entry_date: '2026-09-02', reversed_by_je: null },
    { id: 'e2', je_no: 'JE-2', source_type: 'DI_REVERSAL', source_doc_no: 'HC-DI-2609-001', reversed: false, posted: true, entry_date: '2026-09-02', reversed_by_je: 'e1' },
    { id: 'e9', je_no: 'JE-9', source_type: 'DI', source_doc_no: 'HC-DI-2609-001', reversed: false, posted: true, entry_date: '2026-09-02', reversed_by_je: null },
  ];
  const lines = [
    { journal_entry_id: 'e9', account_code: '300-0000', debit_sen: 100_000, credit_sen: 0, party_code: '300-C002' },
    { journal_entry_id: 'e9', account_code: '509-0000', debit_sen: 0, credit_sen: 100_000, party_code: null },
    { journal_entry_id: 'e9', account_code: '619-0000', debit_sen: 34_000, credit_sen: 0, party_code: null },
    { journal_entry_id: 'e9', account_code: '410-0080', debit_sen: 0, credit_sen: 34_000, party_code: null },
  ];
  const check = (over = {}) => repostProblems({ di, oldJeNo: 'JE-1', entries, lines, roles: ROLES, pct: 34, ...over });

  test('as it should be: no problem', () => {
    expect(check()).toEqual([]);
  });
  test('the wrong cost recorded, or a second standing entry', () => {
    expect(check({ di: { ...di, cost_sen: 0 } })).toEqual(['HC-DI-2609-001: records a cost of 0 sen, not 34000']);
    expect(check({ entries: [...entries.slice(0, 2), { ...entries[0], reversed: false }, entries[2]] })[0]).toMatch(/2 standing DI entries/);
  });
  test('an old entry not reversed, or its contra on another day', () => {
    expect(check({ entries: [{ ...entries[0], reversed: false, je_no: 'JE-1' }, entries[1], { ...entries[2] }] }).join(' ')).toMatch(/standing DI entries|not reversed/);
    expect(check({ entries: [entries[0], { ...entries[1], entry_date: '2026-11-26' }, entries[2]] })).toEqual(['HC-DI-2609-001: the old entry JE-1 has no posted contra on its own day']);
  });
  test('a new entry without the cost lines, or with another party', () => {
    const shaped = /is not Dr 300-0000 \(the invoice's party\) \/ Cr 509-0000 for the deposit and Dr 619-0000 \/ Cr 410-0080 for 34% of it/;
    expect(check({ lines: lines.slice(0, 2) }).join(' ')).toMatch(shaped);
    expect(check({ lines: [{ ...lines[0], party_code: '300-C001' }, ...lines.slice(1)] }).join(' ')).toMatch(shaped);
    expect(check({ lines: [...lines.slice(0, 2), { ...lines[2], debit_sen: 33_999 }, lines[3]] }).join(' ')).toMatch(shaped);
  });
});
