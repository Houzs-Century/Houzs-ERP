/* The Finance corrections report, decided without a database.
 *
 * Owner 2026-09-10: a report of every payment correction made on the amend
 * right, with the reason typed at the time and what it did to the ledger. The
 * route reads `mfg_so_audit_log`; this file pins what each row MEANS and what
 * the summary cards add up to — including the two ways a row can be missing
 * a half (a never-booked payment reverses nothing; a delete books nothing).
 */
import { describe, expect, it } from 'vitest';
import {
  AMEND_SOURCE, LEDGER_FIELD, LEDGER_REVERSAL_FIELD, REASON_REQUIRED,
  ledgerFieldChange, paymentCorrectionsReport, type CorrectionAuditRow,
} from './payment-corrections';

const audit = (over: Partial<CorrectionAuditRow> = {}): CorrectionAuditRow => ({
  id: 'a1',
  so_doc_no: '2990-SO-2606-043',
  action: 'UPDATE_PAYMENT',
  actor_name_snapshot: 'Chew',
  field_changes: [
    { field: 'amountSen', from: 199_000, to: 199_100 },
    { field: LEDGER_FIELD, from: 'JE-2609-0031', to: 'JE-2609-0058' },
    { field: LEDGER_REVERSAL_FIELD, from: null, to: 'JE-2609-0057' },
  ],
  note: 'Sales keyed RM 1,990 — receipt shows RM 1,991',
  created_at: '2026-09-10T02:15:00Z',
  ...over,
});

const customers = new Map<string, string | null>([['2990-SO-2606-043', 'Wong li way']]);

describe('ledgerFieldChange', () => {
  /* `ledger` says what replaced what — the ORIGINAL entry and the one booked
     in its place. The contra that did the voiding is its own change, because
     a reader who sees only "0099 → 0100" takes 0099 for the entry that was
     reversed, when 0099 IS the reversal (owner, 2026-09-10: 不明白). */
  it('names the original → the new entry, and the contra beside it', () => {
    expect(ledgerFieldChange({ originalJeNo: 'JE-47', contraJeNo: 'JE-99', jeNo: 'JE-100' })).toEqual([
      { field: LEDGER_FIELD, from: 'JE-47', to: 'JE-100' },
      { field: LEDGER_REVERSAL_FIELD, from: null, to: 'JE-99' },
    ]);
  });

  it('a delete has an original and a contra, and nothing new', () => {
    expect(ledgerFieldChange({ originalJeNo: 'JE-47', contraJeNo: 'JE-99', jeNo: null })).toEqual([
      { field: LEDGER_FIELD, from: 'JE-47', to: null },
      { field: LEDGER_REVERSAL_FIELD, from: null, to: 'JE-99' },
    ]);
  });

  it('a payment that had never booked has only the new entry, and no reversal line', () => {
    expect(ledgerFieldChange({ originalJeNo: null, contraJeNo: null, jeNo: 'JE-100' }))
      .toEqual([{ field: LEDGER_FIELD, from: null, to: 'JE-100' }]);
  });

  /* An audit row must not claim the books moved when they did not. */
  it('writes nothing when the ledger was not touched', () => {
    expect(ledgerFieldChange({ originalJeNo: null, contraJeNo: null, jeNo: null })).toEqual([]);
  });
});

describe('the constants the routes and the report share', () => {
  it('names the source and refuses in a sentence with no machinery in it', () => {
    expect(AMEND_SOURCE).toBe('amend');
    expect(REASON_REQUIRED.error).toBe('reason_required');
    expect(REASON_REQUIRED.reason).not.toMatch(/[{}]|\bnull\b|reason_required/);
  });
});

describe('paymentCorrectionsReport', () => {
  it('reads an edited amount: both figures, the reason, and all three JE numbers', () => {
    const { rows } = paymentCorrectionsReport([audit()], customers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'edited', by: 'Chew', docNo: '2990-SO-2606-043', customer: 'Wong li way',
      amountFromSen: 199_000, amountToSen: 199_100,
      reason: 'Sales keyed RM 1,990 — receipt shows RM 1,991',
      originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
    });
  });

  /* The one row written before the contra had its own change (2026-09-10,
     2990-SO-2606-043): `ledger` carried the CONTRA as `from`. It must read as
     what it is — a reversal with the original unknown — never as an original. */
  it('reads a legacy row, where the contra rode in `from`, as contra-only', () => {
    const { rows } = paymentCorrectionsReport([audit({
      field_changes: [{ field: 'amountSen', from: 30_800, to: 30_700 }, { field: LEDGER_FIELD, from: '2990-JE-2606-0099', to: '2990-JE-2606-0100' }],
    })], customers);
    expect(rows[0]).toMatchObject({ originalJeNo: null, contraJeNo: '2990-JE-2606-0099', jeNo: '2990-JE-2606-0100' });
  });

  it('keeps the ledger changes OUT of the visible changes — they have their own columns', () => {
    const { rows } = paymentCorrectionsReport([audit()], customers);
    expect(rows[0].changes.map((c) => c.field)).toEqual(['amountSen']);
  });

  it('reads a delete: the money that was removed, a contra, and no new entry', () => {
    const { rows } = paymentCorrectionsReport([audit({
      action: 'DELETE_PAYMENT',
      field_changes: [
        { field: 'paidAt', from: '2026-08-30', to: null },
        { field: 'method', from: 'cash', to: null },
        { field: 'amountSen', from: 50_000, to: null },
        { field: LEDGER_FIELD, from: 'JE-2608-0388', to: null },
        { field: LEDGER_REVERSAL_FIELD, from: null, to: 'JE-2609-0012' },
      ],
      note: 'Keyed twice',
    })], customers);
    expect(rows[0]).toMatchObject({ kind: 'deleted', amountFromSen: 50_000, amountToSen: null, originalJeNo: 'JE-2608-0388', contraJeNo: 'JE-2609-0012', jeNo: null });
  });

  it('an edit that did not touch the amount carries no figures', () => {
    const { rows } = paymentCorrectionsReport([audit({
      field_changes: [{ field: 'method', from: 'cash', to: 'transfer' }, { field: LEDGER_FIELD, from: 'JE-1', to: 'JE-2' }],
    })], customers);
    expect(rows[0].amountFromSen).toBeNull();
    expect(rows[0].amountToSen).toBeNull();
    expect(rows[0].changes).toEqual([{ field: 'method', from: 'cash', to: 'transfer' }]);
  });

  it('a payment that had never booked reverses nothing, and the row says so', () => {
    const { rows } = paymentCorrectionsReport([audit({
      field_changes: [{ field: 'amountSen', from: 1, to: 2 }, { field: LEDGER_FIELD, from: null, to: 'JE-9' }],
    })], customers);
    expect(rows[0]).toMatchObject({ originalJeNo: null, contraJeNo: null, jeNo: 'JE-9' });
  });

  it('survives an audit row whose changes are not a list', () => {
    const { rows } = paymentCorrectionsReport([audit({ field_changes: 'garbage' })], customers);
    expect(rows[0].changes).toEqual([]);
    expect(rows[0].jeNo).toBeNull();
  });

  it('an order it could not read shows no customer rather than a wrong one', () => {
    const { rows } = paymentCorrectionsReport([audit({ so_doc_no: 'SO-GONE' })], customers);
    expect(rows[0].customer).toBeNull();
  });

  it('a missing actor name reads as a dash, and a blank reason as empty', () => {
    const { rows } = paymentCorrectionsReport([audit({ actor_name_snapshot: null, note: '   ' })], customers);
    expect(rows[0].by).toBe('—');
    expect(rows[0].reason).toBe('');
  });

  it('newest first — this morning is what is being asked about', () => {
    const { rows } = paymentCorrectionsReport([
      audit({ id: 'old', created_at: '2026-09-01T00:00:00Z' }),
      audit({ id: 'new', created_at: '2026-09-10T00:00:00Z' }),
    ], customers);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('the summary adds up edits, deletes, and the net money moved', () => {
    const { summary } = paymentCorrectionsReport([
      audit({ id: 'a' }),                                                          // +100
      audit({ id: 'b', field_changes: [{ field: 'amountSen', from: 240_000, to: 200_000 }] }), // −40,000
      audit({ id: 'c', field_changes: [{ field: 'method', from: 'cash', to: 'transfer' }] }),  // no amount
      audit({ id: 'd', action: 'DELETE_PAYMENT', field_changes: [{ field: 'amountSen', from: 50_000, to: null }] }), // −50,000
    ], customers);
    expect(summary).toEqual({ corrections: 4, edited: 3, deleted: 1, netMovedSen: 100 - 40_000 - 50_000, deletedSen: 50_000 });
  });

  it('an empty month is an empty report, not a crash', () => {
    expect(paymentCorrectionsReport([], customers))
      .toEqual({ rows: [], summary: { corrections: 0, edited: 0, deleted: 0, netMovedSen: 0, deletedSen: 0 } });
  });
});
