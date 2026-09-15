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
  AMEND_SOURCE, KEY_HOLDER_REASON_REQUIRED, LEDGER_FIELD, LEDGER_REVERSAL_FIELD, REASON_REQUIRED, SLIP_FIELD,
  addedAmountOf, ledgerFieldChange, paymentCorrectionsReport, type CorrectionAuditRow, type RecorderLookup,
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
  payment_id: 'pay-1',
  source: AMEND_SOURCE,
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

  /* The holder's refusal is shown to the operator, so it must survive the
     client's sentence filter (under 200 characters, docs/bugs/0821) and say
     where the action will be listed. */
  it("the holder's refusal is one plain sentence under the client's ceiling, naming the report", () => {
    expect(KEY_HOLDER_REASON_REQUIRED.error).toBe('reason_required');
    expect(KEY_HOLDER_REASON_REQUIRED.reason.length).toBeLessThan(200);
    expect(KEY_HOLDER_REASON_REQUIRED.reason).not.toMatch(/[{}]|\bnull\b|reason_required/);
    expect(KEY_HOLDER_REASON_REQUIRED.reason).toContain('Corrections');
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
    expect(summary).toEqual({
      corrections: 4, added: 0, edited: 3, deleted: 1, proof: 0,
      netMovedSen: 100 - 40_000 - 50_000, addedSen: 0, deletedSen: 50_000,
    });
  });

  it('an empty month is an empty report, not a crash', () => {
    expect(paymentCorrectionsReport([], customers))
      .toEqual({ rows: [], summary: { corrections: 0, added: 0, edited: 0, deleted: 0, proof: 0, netMovedSen: 0, addedSen: 0, deletedSen: 0 } });
  });
});

/* EVERY payment action by a role holding the right (owner 2026-09-14,
   docs/bugs/0888): an add and a proof attach are rows of their own kind, a row
   from before the rule carries no reason and says so, and each row names who
   FIRST recorded the payment it concerns. */
const added = (over: Partial<CorrectionAuditRow> = {}): CorrectionAuditRow => audit({
  id: 'add-1', action: 'ADD_PAYMENT', note: 'Balance collected on delivery',
  field_changes: [
    { field: 'paidAt', from: null, to: '2026-09-14' },
    { field: 'method', from: null, to: 'cash' },
    { field: 'amountSen', from: null, to: 150_000 },
    { field: LEDGER_FIELD, from: null, to: 'JE-2609-0090' },
  ],
  created_at: '2026-09-14T03:00:00Z',
  ...over,
});

describe('the kinds a row can be', () => {
  it('an ADD_PAYMENT row is an add: the money recorded, the entry booked, the recorder is itself', () => {
    const { rows, summary } = paymentCorrectionsReport([added()], customers);
    expect(rows[0]).toMatchObject({
      kind: 'added', amountFromSen: null, amountToSen: 150_000, reason: 'Balance collected on delivery',
      beforeRule: false, recordedBy: 'Chew', recordedOn: '2026-09-14T03:00:00Z',
      originalJeNo: null, contraJeNo: null, jeNo: 'JE-2609-0090',
    });
    expect(rows[0].changes.map((c) => c.field)).toEqual(['paidAt', 'method', 'amountSen']);
    expect(summary).toMatchObject({ added: 1, addedSen: 150_000, netMovedSen: 150_000 });
  });

  it('an UPDATE_PAYMENT row that moved only the proof is a proof attach, and counts as neither an edit nor money', () => {
    const { rows, summary } = paymentCorrectionsReport([audit({
      field_changes: [{ field: SLIP_FIELD, from: null, to: 'slips/abc.jpg' }], note: 'Slip came in by WhatsApp',
    })], customers);
    expect(rows[0]).toMatchObject({ kind: 'proof', amountFromSen: null, amountToSen: null, reason: 'Slip came in by WhatsApp' });
    expect(summary).toMatchObject({ proof: 1, edited: 0, netMovedSen: 0 });
  });

  it('an edit that touched the proof AND the money is still an edit', () => {
    const { rows } = paymentCorrectionsReport([audit({
      field_changes: [{ field: SLIP_FIELD, from: null, to: 'slips/abc.jpg' }, { field: 'amountSen', from: 1, to: 2 }],
    })], customers);
    expect(rows[0].kind).toBe('edited');
  });

  it('the summary adds an add, an edit, a delete and a proof up separately, and nets the money', () => {
    const { summary } = paymentCorrectionsReport([
      added({ id: 'a' }),                                                                                        // +150,000
      audit({ id: 'b' }),                                                                                        // +100
      audit({ id: 'c', action: 'DELETE_PAYMENT', field_changes: [{ field: 'amountSen', from: 50_000, to: null }] }), // −50,000
      audit({ id: 'd', field_changes: [{ field: SLIP_FIELD, from: null, to: 'k' }] }),
    ], customers);
    expect(summary).toEqual({
      corrections: 4, added: 1, edited: 1, deleted: 1, proof: 1,
      netMovedSen: 150_000 + 100 - 50_000, addedSen: 150_000, deletedSen: 50_000,
    });
  });
});

describe('a row from before the rule', () => {
  /* The owner's own two adds of 2026-09-14, recorded before this shipped: a
     role that holds the right today, a row nothing asked a reason for. Listed,
     marked, and its own note — "Payment proof attached" on a proof row — is
     NOT presented as a reason. */
  it('carries no reason, says it predates the rule, and does not pass its own note off as one', () => {
    const { rows } = paymentCorrectionsReport([
      added({ id: 'early', source: 'web', note: null }),
      audit({ id: 'early-proof', source: 'web', note: 'Payment proof attached', field_changes: [{ field: SLIP_FIELD, from: null, to: 'k' }] }),
    ], customers);
    expect(rows.find((r) => r.id === 'early')).toMatchObject({ kind: 'added', reason: '', beforeRule: true });
    expect(rows.find((r) => r.id === 'early-proof')).toMatchObject({ kind: 'proof', reason: '', beforeRule: true });
  });

  it('a row made on the right is not from before the rule', () => {
    expect(paymentCorrectionsReport([audit()], customers).rows[0].beforeRule).toBe(false);
  });
});

describe('who first recorded the payment', () => {
  const lookup = (over: Partial<RecorderLookup> = {}): RecorderLookup => ({
    addsByPayment: new Map(), paymentsById: new Map(), addsByDoc: new Map(), ...over,
  });

  it('a tagged correction names the actor of the payment\'s ADD row, and the day it was keyed', () => {
    const { rows } = paymentCorrectionsReport([audit()], customers, lookup({
      addsByPayment: new Map([['pay-1', { by: 'Rachael', on: '2026-08-29T06:00:00Z' }]]),
      paymentsById: new Map([['pay-1', { by: 'Somebody else', on: '2026-08-29T06:00:01Z' }]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: 'Rachael', recordedOn: '2026-08-29T06:00:00Z' });
  });

  /* The scan job's ADD row snapshots no actor ("Auto: payment recorded from
     scanned receipt"); the person is the collector named on the payment. */
  it('an ADD row that names nobody defers to the collector on the payment row, keeping the ADD row\'s day', () => {
    const { rows } = paymentCorrectionsReport([audit()], customers, lookup({
      addsByPayment: new Map([['pay-1', { by: null, on: '2026-08-29T06:00:00Z' }]]),
      paymentsById: new Map([['pay-1', { by: 'Wei How', on: '2026-08-29T06:00:01Z' }]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: 'Wei How', recordedOn: '2026-08-29T06:00:00Z' });
  });

  it('a payment whose ADD row predates the tagging is read off the payment row itself', () => {
    const { rows } = paymentCorrectionsReport([audit()], customers, lookup({
      paymentsById: new Map([['pay-1', { by: 'Wei How', on: '2026-08-29T06:00:01Z' }]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: 'Wei How', recordedOn: '2026-08-29T06:00:01Z' });
  });

  it('a tagged row nothing can be read for is recorder unknown, never a guess', () => {
    const { rows } = paymentCorrectionsReport([audit()], customers, lookup());
    expect(rows[0]).toMatchObject({ recordedBy: null, recordedOn: null });
  });

  /* The corrections written before payments were tagged — the owner's nine of
     2026-09-10 to 2026-09-14 — carry no id. The order's own ADD rows are the
     only trail: one add before the correction is that payment; two adds are
     told apart by the amount the correction started from; two that cannot be
     told apart stay blank, because naming the wrong salesperson is worse. */
  it('an untagged correction on an order with exactly one earlier add names that add', () => {
    const { rows } = paymentCorrectionsReport([audit({ payment_id: null })], customers, lookup({
      addsByDoc: new Map([['2990-SO-2606-043', [
        { by: 'Rachael', on: '2026-08-29T06:00:00Z', amountSen: 199_000 },
        { by: 'Later', on: '2026-09-11T06:00:00Z', amountSen: 10 }, // after the correction: not this one
      ]]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: 'Rachael', recordedOn: '2026-08-29T06:00:00Z' });
  });

  it('two earlier adds are told apart by the amount the correction started from', () => {
    const { rows } = paymentCorrectionsReport([audit({ payment_id: null })], customers, lookup({
      addsByDoc: new Map([['2990-SO-2606-043', [
        { by: 'Rachael', on: '2026-08-29T06:00:00Z', amountSen: 50_000 },
        { by: 'Zack', on: '2026-09-01T06:00:00Z', amountSen: 199_000 },
      ]]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: 'Zack', recordedOn: '2026-09-01T06:00:00Z' });
  });

  it('two earlier adds it cannot tell apart leave the recorder blank', () => {
    const { rows } = paymentCorrectionsReport([audit({ payment_id: null, field_changes: [{ field: 'method', from: 'cash', to: 'transfer' }] })], customers, lookup({
      addsByDoc: new Map([['2990-SO-2606-043', [
        { by: 'Rachael', on: '2026-08-29T06:00:00Z', amountSen: 50_000 },
        { by: 'Zack', on: '2026-09-01T06:00:00Z', amountSen: 199_000 },
      ]]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: null, recordedOn: null });
  });

  it('an add names itself, whatever the lookups say', () => {
    const { rows } = paymentCorrectionsReport([added()], customers, lookup({
      addsByPayment: new Map([['pay-1', { by: 'Rachael', on: '2026-08-29T06:00:00Z' }]]),
    }));
    expect(rows[0]).toMatchObject({ recordedBy: 'Chew', recordedOn: '2026-09-14T03:00:00Z' });
  });

  it('addedAmountOf reads the amount an ADD row recorded, and nothing when there is none', () => {
    expect(addedAmountOf([{ field: 'amountSen', from: null, to: 150_000 }])).toBe(150_000);
    expect(addedAmountOf([{ field: 'method', from: null, to: 'cash' }])).toBeNull();
    expect(addedAmountOf('garbage')).toBeNull();
  });
});
