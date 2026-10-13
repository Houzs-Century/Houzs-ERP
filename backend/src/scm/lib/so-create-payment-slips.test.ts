import { describe, expect, it } from 'vitest';
import { SLIP_REQUIRED_REASON } from '../shared/payment-slip-required';
import {
  claimedSlipSessionIds,
  planCreatePaymentSlips,
  soCreatePaymentSchema,
  soCreatePaymentsSchema,
  type PendingSlipRow,
} from './so-create-payment-slips';

/* ═══════════════════════════════════════════════════════════════════════════
   Owner 2026-10-13, after Admin: "please make sure when collect payment is
   attached with slip." Reverses the 2026-08-13 slip-optional ruling.

   THIS FILE PINS THE BOUNDARY FROM BOTH SIDES, because both sides are money:
     · a keyed payment with NO slip is REFUSED, and the whole create with it
     · a converted row (money moved from another order) still books slip-less
     · a payment WITH a slip attaches that exact key, and a slip that is
       claimed but does not resolve is still REFUSED (not the same rule)
   ═══════════════════════════════════════════════════════════════════════════ */

const row = (o: Record<string, unknown> = {}) => ({
  method: 'cash',
  amountSen: 50_00,
  ...o,
});

const uploaded = (key: string): PendingSlipRow => ({ r2_key: key, status: 'uploaded' });
/** A hand-keyed row as the plan sees it. */
const keyed = (o: { uploadSessionId?: string | null } = {}) => ({ method: 'cash' as const, ...o });
const converted = () => ({ method: 'converted' as const });

describe('the create payments[] schema', () => {
  it('parses a row with no slip — the refusal is the PLAN, in the shared sentence, not a zod issue', () => {
    const parsed = soCreatePaymentSchema.safeParse(row());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.uploadSessionId).toBeUndefined();
    expect(soCreatePaymentSchema.safeParse(row({ uploadSessionId: null })).success).toBe(true);
  });

  it('keeps a supplied slip session', () => {
    const parsed = soCreatePaymentSchema.safeParse(row({ uploadSessionId: 'sess-1' }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.uploadSessionId).toBe('sess-1');
  });

  it('rejects an EMPTY-STRING session rather than treating it as slip-less', () => {
    /* '' is a client forgetting to omit the field. Accepting it would make the
       resolution step hunt for a session nobody claimed. */
    expect(soCreatePaymentSchema.safeParse(row({ uploadSessionId: '' })).success).toBe(false);
  });

  it('keeps every OTHER field as strict as it was', () => {
    expect(soCreatePaymentSchema.safeParse(row({ amountSen: 0 })).success).toBe(false);
    expect(soCreatePaymentSchema.safeParse(row({ amountSen: -1 })).success).toBe(false);
    expect(soCreatePaymentSchema.safeParse(row({ method: 'crypto' })).success).toBe(false);
    expect(soCreatePaymentsSchema.safeParse([]).success).toBe(false);
    expect(soCreatePaymentsSchema.safeParse(Array(11).fill(row())).success).toBe(false);
  });
});

describe('what the create looks up', () => {
  it('asks for nothing when no row claims a slip', () => {
    expect(claimedSlipSessionIds([{ uploadSessionId: null }, {}])).toEqual([]);
  });

  it('asks only for the sessions actually claimed', () => {
    expect(claimedSlipSessionIds([
      { uploadSessionId: 'a' }, {}, { uploadSessionId: 'b' },
    ])).toEqual(['a', 'b']);
  });
});

describe('a keyed payment without its slip (the owner ruling)', () => {
  it('refuses the row, naming it, in the shared sentence', () => {
    expect(planCreatePaymentSlips([keyed()], new Map())).toEqual({ ok: false, reason: `Payment 1: ${SLIP_REQUIRED_REASON}` });
    expect(planCreatePaymentSlips([keyed({ uploadSessionId: null })], new Map()).ok).toBe(false);
  });

  it('refuses the WHOLE create when one row of a split has no slip', () => {
    const plan = planCreatePaymentSlips(
      [keyed({ uploadSessionId: 'sess-a' }), keyed()],
      new Map([['sess-a', uploaded('key-a')]]),
    );
    expect(plan).toEqual({ ok: false, reason: `Payment 2: ${SLIP_REQUIRED_REASON}` });
  });

  it('a converted row books slip-less — the money was receipted when first collected', () => {
    expect(planCreatePaymentSlips([converted(), converted()], new Map())).toEqual({ ok: true, slipKeys: [null, null] });
  });
});

describe('a slip that IS supplied still attaches, positionally', () => {
  it('resolves the R2 key onto the row that claimed it', () => {
    const plan = planCreatePaymentSlips(
      [keyed({ uploadSessionId: 'sess-a' })],
      new Map([['sess-a', uploaded('slips/2026/08/a.jpg')]]),
    );
    expect(plan).toEqual({ ok: true, slipKeys: ['slips/2026/08/a.jpg'] });
  });

  it('keeps the pairing right in a MIXED create (this is the money detail)', () => {
    /* slipKeys is consumed by index against posPayments. Get the alignment
       wrong and a payment is booked with another payment's proof. */
    const plan = planCreatePaymentSlips(
      [converted(), keyed({ uploadSessionId: 'sess-b' }), converted(), keyed({ uploadSessionId: 'sess-d' })],
      new Map([['sess-b', uploaded('key-b')], ['sess-d', uploaded('key-d')]]),
    );
    expect(plan).toEqual({ ok: true, slipKeys: [null, 'key-b', null, 'key-d'] });
  });
});

describe('a slip that is CLAIMED but not real is still refused', () => {
  it('refuses a session that resolves to nothing', () => {
    const plan = planCreatePaymentSlips([keyed({ uploadSessionId: 'ghost' })], new Map());
    expect(plan).toEqual({ ok: false, reason: 'Payment 1 slip missing or not uploaded.' });
  });

  it('refuses a session whose upload never completed', () => {
    const plan = planCreatePaymentSlips(
      [keyed({ uploadSessionId: 'sess-a' })],
      new Map([['sess-a', { r2_key: null, status: 'init' }]]),
    );
    expect(plan.ok).toBe(false);
  });

  it("refuses a 'promoted' session — it belongs to an earlier payment (replay)", () => {
    const plan = planCreatePaymentSlips(
      [keyed({ uploadSessionId: 'sess-a' })],
      new Map([['sess-a', { r2_key: 'key-a', status: 'promoted' }]]),
    );
    expect(plan.ok).toBe(false);
  });

  it('names the row by its position in the submitted array, not among slips', () => {
    const plan = planCreatePaymentSlips(
      [converted(), converted(), keyed({ uploadSessionId: 'ghost' })],
      new Map(),
    );
    expect(plan).toEqual({ ok: false, reason: 'Payment 3 slip missing or not uploaded.' });
  });

  it('refuses two payments claiming the SAME slip', () => {
    const plan = planCreatePaymentSlips(
      [keyed({ uploadSessionId: 'sess-a' }), keyed({ uploadSessionId: 'sess-a' })],
      new Map([['sess-a', uploaded('key-a')]]),
    );
    expect(plan).toEqual({ ok: false, reason: 'Each payment needs its own slip.' });
  });

  it('refuses the WHOLE create, not just the bad row', () => {
    /* All-or-nothing: the caller runs this before the header insert, so a
       create is never left with half its proofs missing. */
    const plan = planCreatePaymentSlips(
      [keyed({ uploadSessionId: 'good' }), keyed({ uploadSessionId: 'ghost' })],
      new Map([['good', uploaded('key-good')]]),
    );
    expect(plan.ok).toBe(false);
    expect(plan).not.toHaveProperty('slipKeys');
  });
});
