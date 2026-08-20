import { describe, expect, it } from 'vitest';
import {
  claimedSlipSessionIds,
  planCreatePaymentSlips,
  soCreatePaymentSchema,
  soCreatePaymentsSchema,
  type PendingSlipRow,
} from './so-create-payment-slips';

/* ═══════════════════════════════════════════════════════════════════════════
   Owner 2026-08-13: "其实 SalesOrder 所有的付款都不强制 ... 如果我们用 OCR scan
   的话,它就可以直接进。那如果是 manually 填写的话,基本上不需要强求."

   THIS FILE PINS THE BOUNDARY FROM BOTH SIDES, because both sides are money:
     · a payment with NO slip must SAVE      (the new rule)
     · a payment WITH a slip must still ATTACH that exact key, and a slip that
       is claimed but does not resolve must still be REFUSED   (the old rule,
       which is not the same rule and did not go away)
   ═══════════════════════════════════════════════════════════════════════════ */

const row = (o: Record<string, unknown> = {}) => ({
  method: 'cash',
  amountSen: 50_00,
  ...o,
});

const uploaded = (key: string): PendingSlipRow => ({ r2_key: key, status: 'uploaded' });

describe('the create payments[] schema', () => {
  it('accepts a payment with NO slip at all — the owner ruling', () => {
    const parsed = soCreatePaymentSchema.safeParse(row());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.uploadSessionId).toBeUndefined();
  });

  it('accepts an explicit null slip (a client that sends the key blanked)', () => {
    expect(soCreatePaymentSchema.safeParse(row({ uploadSessionId: null })).success).toBe(true);
  });

  it('still accepts — and keeps — a supplied slip session', () => {
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

  it('a whole slip-less split payment parses', () => {
    const parsed = soCreatePaymentsSchema.safeParse([
      row({ method: 'cash', amountSen: 30_00 }),
      row({ method: 'transfer', amountSen: 20_00 }),
    ]);
    expect(parsed.success).toBe(true);
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

describe('slip-less payments (the owner ruling)', () => {
  it('every row saves, each recorded with a null slip key', () => {
    const plan = planCreatePaymentSlips([{}, { uploadSessionId: null }], new Map());
    expect(plan).toEqual({ ok: true, slipKeys: [null, null] });
  });

  it('two slip-less rows are not a duplicate-slip collision', () => {
    /* The dedupe guard reads "two payments claiming one photo". Absent is not
       a claim, so a cash + transfer split with no proof at all must not trip
       it — this is the shape a hand-keyed split payment takes. */
    const plan = planCreatePaymentSlips([{}, {}, {}], new Map());
    expect(plan.ok).toBe(true);
  });
});

describe('a slip that IS supplied still attaches, positionally', () => {
  it('resolves the R2 key onto the row that claimed it', () => {
    const plan = planCreatePaymentSlips(
      [{ uploadSessionId: 'sess-a' }],
      new Map([['sess-a', uploaded('slips/2026/08/a.jpg')]]),
    );
    expect(plan).toEqual({ ok: true, slipKeys: ['slips/2026/08/a.jpg'] });
  });

  it('keeps the pairing right in a MIXED create (this is the money detail)', () => {
    /* slipKeys is consumed by index against posPayments. Get the alignment
       wrong and a payment is booked with another payment's proof. */
    const plan = planCreatePaymentSlips(
      [{}, { uploadSessionId: 'sess-b' }, {}, { uploadSessionId: 'sess-d' }],
      new Map([['sess-b', uploaded('key-b')], ['sess-d', uploaded('key-d')]]),
    );
    expect(plan).toEqual({ ok: true, slipKeys: [null, 'key-b', null, 'key-d'] });
  });
});

describe('a slip that is CLAIMED but not real is still refused', () => {
  it('refuses a session that resolves to nothing', () => {
    const plan = planCreatePaymentSlips([{ uploadSessionId: 'ghost' }], new Map());
    expect(plan).toEqual({ ok: false, reason: 'Payment 1 slip missing or not uploaded.' });
  });

  it('refuses a session whose upload never completed', () => {
    const plan = planCreatePaymentSlips(
      [{ uploadSessionId: 'sess-a' }],
      new Map([['sess-a', { r2_key: null, status: 'init' }]]),
    );
    expect(plan.ok).toBe(false);
  });

  it("refuses a 'promoted' session — it belongs to an earlier payment (replay)", () => {
    const plan = planCreatePaymentSlips(
      [{ uploadSessionId: 'sess-a' }],
      new Map([['sess-a', { r2_key: 'key-a', status: 'promoted' }]]),
    );
    expect(plan.ok).toBe(false);
  });

  it('names the row by its position in the submitted array, not among slips', () => {
    const plan = planCreatePaymentSlips(
      [{}, {}, { uploadSessionId: 'ghost' }],
      new Map(),
    );
    expect(plan).toEqual({ ok: false, reason: 'Payment 3 slip missing or not uploaded.' });
  });

  it('refuses two payments claiming the SAME slip', () => {
    const plan = planCreatePaymentSlips(
      [{ uploadSessionId: 'sess-a' }, { uploadSessionId: 'sess-a' }],
      new Map([['sess-a', uploaded('key-a')]]),
    );
    expect(plan).toEqual({ ok: false, reason: 'Each payment needs its own slip.' });
  });

  it('refuses the WHOLE create, not just the bad row', () => {
    /* All-or-nothing: the caller runs this before the header insert, so a
       create is never left with half its proofs missing. */
    const plan = planCreatePaymentSlips(
      [{ uploadSessionId: 'good' }, { uploadSessionId: 'ghost' }],
      new Map([['good', uploaded('key-good')]]),
    );
    expect(plan.ok).toBe(false);
    expect(plan).not.toHaveProperty('slipKeys');
  });
});
