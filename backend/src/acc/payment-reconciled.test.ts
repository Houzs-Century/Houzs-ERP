/* Has this payment already been reconciled?
 *
 * The server's half of step 3 (owner + management, 2026-09-10): Finance may
 * correct a mis-keyed payment, but not one the books have already closed over.
 * `paymentRowMutable` decides what that MEANS; this file answers whether it
 * has happened, and it is the only place that reads the settlement and bank
 * tables to find out.
 *
 * There are three genuinely different places the books can close over a
 * payment, and an operator told only "it is reconciled" cannot go and look at
 * the one that did — so all three are named:
 *   merchant — the row was matched on a merchant settlement report; its fee is
 *              booked and the report has been reconciled against a payout.
 *   bank     — its journal entry has been claimed by a movement on a bank
 *              statement. One entry cannot account for two movements.
 *   month    — that account's month has been closed and reported.
 *
 * EVERY READ FAILS CLOSED. "I could not tell" must never come back as "no", or
 * this whole guard turns off exactly when the database is unhappy — which is
 * the shape of failure the bank-lock guard was already written to refuse
 * (acc/bank.ts, loadLineMonth).
 */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { paymentMayChange, paymentReconciliation, RECONCILIATION_UNREADABLE } from './payment-reconciled';
import { PAYMENT_WINDOW_CLOSED_MESSAGE } from '../scm/shared/so-field-policy';

const JE: Row = {
  id: 'je-1', je_no: 'JE-2608-0031', company_id: 1,
  source_type: 'SOPAY', source_doc_no: 'pay-1', entry_date: '2026-08-02',
  posted: true, reversed: false, total_debit_sen: 199_000,
};

const LINES: Row[] = [
  { id: 'l1', journal_entry_id: 'je-1', line_no: 1, account_code: '310-0010', debit_sen: 199_000, credit_sen: 0 },
  { id: 'l2', journal_entry_id: 'je-1', line_no: 2, account_code: '300-0000', debit_sen: 0, credit_sen: 199_000 },
];

const world = (over: {
  matches?: Row[]; bankMatches?: Row[]; locks?: Row[]; jes?: Row[]; lines?: Row[];
} = {}, missing: Record<string, string[]> = {}) => fakeSb({
  acc_settlement_matches: over.matches ?? [],
  acc_bank_statement_matches: over.bankMatches ?? [],
  acc_bank_month_locks: over.locks ?? [],
  journal_entries: over.jes ?? [JE],
  journal_entry_lines: over.lines ?? LINES,
}, missing);

describe('paymentReconciliation', () => {
  it('answers NOTHING when no reconciliation has claimed it', async () => {
    expect(await paymentReconciliation(world(), 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  it('names a MERCHANT match, and the day it was matched', async () => {
    const sb = world({
      matches: [{
        id: 1, company_id: 1, payment_source: 'SOPAY', payment_id: 'pay-1',
        settlement_row_id: 9, amount_sen: 199_000, created_at: '2026-08-05T09:12:00+08:00',
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1'))
      .toEqual({ ok: true, by: { kind: 'merchant', on: '2026-08-05' } });
  });

  it('names a BANK match by the entry that was claimed', async () => {
    const sb = world({
      bankMatches: [{ id: 1, company_id: 1, bank_line_id: 5, je_no: 'JE-2608-0031', amount_sen: 199_000 }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1'))
      .toEqual({ ok: true, by: { kind: 'bank', jeNo: 'JE-2608-0031' } });
  });

  it('names a CLOSED MONTH by the account and the month', async () => {
    const sb = world({
      locks: [{
        id: 1, company_id: 1, account_code: '310-0010', period_month: '2026-08-01',
        locked_by: 'u1', locked_at: '2026-09-01T00:00:00Z', released_at: null,
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1'))
      .toEqual({ ok: true, by: { kind: 'month', accountCode: '310-0010', month: '2026-08' } });
  });

  it('reads the month lock off the MONEY leg, not the debtor control', async () => {
    /* The credit leg is Trade Debtors and is never a bank account — a guard
       that looked at the wrong line would find no lock and wave everything
       through. */
    const sb = world({
      locks: [{
        id: 1, company_id: 1, account_code: '300-0000', period_month: '2026-08-01',
        locked_by: 'u1', locked_at: '2026-09-01T00:00:00Z', released_at: null,
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  it('ignores a month lock that has been RELEASED', async () => {
    const sb = world({
      locks: [{
        id: 1, company_id: 1, account_code: '310-0010', period_month: '2026-08-01',
        locked_by: 'u1', locked_at: '2026-09-01T00:00:00Z', released_at: '2026-09-05T00:00:00Z',
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  it('ignores a lock on a DIFFERENT month of the same account', async () => {
    const sb = world({
      locks: [{
        id: 1, company_id: 1, account_code: '310-0010', period_month: '2026-07-01',
        locked_by: 'u1', locked_at: '2026-08-01T00:00:00Z', released_at: null,
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  /* A payment that never reached the ledger has no entry to claim, so neither
     the bank match nor the month lock can speak for it — but a MERCHANT match
     still can, because that one keys on the payment row itself. */
  it('still finds a merchant match on a payment that never booked', async () => {
    const sb = world({
      jes: [], lines: [],
      matches: [{
        id: 1, company_id: 1, payment_source: 'SOPAY', payment_id: 'pay-1',
        settlement_row_id: 9, amount_sen: 199_000, created_at: '2026-08-05T09:12:00+08:00',
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1'))
      .toEqual({ ok: true, by: { kind: 'merchant', on: '2026-08-05' } });
  });

  it('a payment with no entry and no merchant match is simply not reconciled', async () => {
    expect(await paymentReconciliation(world({ jes: [], lines: [] }), 1, 'pay-1'))
      .toEqual({ ok: true, by: null });
  });

  /* A REVERSED entry does not speak for the payment any more — the live one
     does, and here there is none. A bank match against the dead entry's number
     must not close a payment whose current state is unbooked. */
  it('reads only the ACTIVE entry', async () => {
    const sb = world({
      jes: [{ ...JE, reversed: true }],
      bankMatches: [{ id: 1, company_id: 1, bank_line_id: 5, je_no: 'JE-2608-0031', amount_sen: 199_000 }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  it('keeps one company out of another\'s reconciliation', async () => {
    const sb = world({
      matches: [{
        id: 1, company_id: 2, payment_source: 'SOPAY', payment_id: 'pay-1',
        settlement_row_id: 9, amount_sen: 199_000, created_at: '2026-08-05T09:12:00+08:00',
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  it('does not mistake an SI payment\'s match for this one', async () => {
    const sb = world({
      matches: [{
        id: 1, company_id: 1, payment_source: 'SIPAY', payment_id: 'pay-1',
        settlement_row_id: 9, amount_sen: 199_000, created_at: '2026-08-05T09:12:00+08:00',
      }],
    });
    expect(await paymentReconciliation(sb, 1, 'pay-1')).toEqual({ ok: true, by: null });
  });

  /* THE ONE THAT MATTERS MOST. A read that fails is not an absence of
     reconciliation, and answering "not reconciled" would open every locked
     payment the moment the database blinked. */
  it('REFUSES when it cannot read, rather than reporting nothing found', async () => {
    /* Each entry names a column that read SELECTS, withheld from the fake so
       the read errors the way PostgREST does on an unknown column. The columns
       are the load-bearing part: they pin that the read is still made at all. */
    const reads: Array<[string, string]> = [
      ['acc_settlement_matches', 'created_at'],
      ['journal_entries', 'je_no'],
      ['acc_bank_statement_matches', 'je_no'],
      ['journal_entry_lines', 'account_code'],
      ['acc_bank_month_locks', 'account_code'],
    ];
    for (const [table, column] of reads) {
      const sb = world({}, { [table]: [column] });
      const out = await paymentReconciliation(sb, 1, 'pay-1');
      expect(out.ok, `${table} failing was treated as "not reconciled"`).toBe(false);
    }
  });
});

/* The whole answer both routes ask for — the predicate fed the fact it cannot
   fetch. These cases are about the JOIN of the two, not either half: that a
   read failure closes the door, that DRAFT skips the reads entirely, and that
   the amend right reaches an old payment but not a reconciled one. */
describe('paymentMayChange', () => {
  const ask = (sb: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
    paymentMayChange(sb, {
      companyId: 1, paymentId: 'pay-1',
      createdDateMyt: '2026-08-02', todayDateMyt: '2026-09-10',
      soIsDraft: false, mayAmend: false, ...over,
    });

  it('refuses an old payment for somebody without the right', async () => {
    const out = await ask(world());
    expect(out.mutable).toBe(false);
    expect(out.problem).toBe(PAYMENT_WINDOW_CLOSED_MESSAGE);
  });

  it('opens an old payment for a holder of the right', async () => {
    expect(await ask(world(), { mayAmend: true })).toEqual({ mutable: true, problem: null });
  });

  it('refuses the holder of the right once the payment is reconciled', async () => {
    const sb = world({
      bankMatches: [{ id: 1, company_id: 1, bank_line_id: 5, je_no: 'JE-2608-0031', amount_sen: 199_000 }],
    });
    const out = await ask(sb, { mayAmend: true });
    expect(out.mutable).toBe(false);
    expect(out.problem).toMatch(/JE-2608-0031/);
  });

  /* A read it cannot make is not permission to proceed. This is the case that
     turns the whole guard off if it is got wrong, so it is stated plainly. */
  it('refuses when the reconciliation cannot be read, even for a holder', async () => {
    const sb = world({}, { acc_settlement_matches: ['created_at'] });
    const out = await ask(sb, { mayAmend: true });
    expect(out.mutable).toBe(false);
    expect(out.problem).toBe(RECONCILIATION_UNREADABLE);
  });

  /* And a DRAFT is answered before any read happens — withholding a column
     that every read needs proves nothing was asked. */
  it('exempts a DRAFT order without asking the books anything', async () => {
    const sb = world({}, { acc_settlement_matches: ['created_at'], journal_entries: ['je_no'] });
    expect(await ask(sb, { soIsDraft: true })).toEqual({ mutable: true, problem: null });
  });
});
