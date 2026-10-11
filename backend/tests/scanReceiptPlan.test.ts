// Unit tests for the Scan Order receipt→payment PLANNER (lib/scan-receipt-plan).
// Route-level coverage isn't possible in this harness (scm rides Supabase
// Postgres; the DB side of recordScanReceiptPayments is dedup queries + inserts),
// so these pin the PURE decision the background job relies on: given a parse with
// 0 / 1 / N payment receipts, WHICH rows book, for how much, with which method /
// slip proof / deposit flag / date. The "N receipts → N payment rows" contract,
// the "1 receipt unchanged" back-compat, and the "0 receipts → nothing" case all
// live here.
import { describe, expect, test } from 'vitest';
import {
  planReceiptPayments,
  deriveLedgerMethod,
  resolvePaidAt,
  installmentPlanToMonths,
  type ExtractedPayment,
  type PlanReceiptPaymentsInput,
} from '../src/scm/lib/scan-receipt-plan';

const JOB = 'job-abc';
const NOW = Date.parse('2026-07-18T00:00:00Z');
const TODAY = '2026-07-18';

/** Build a planner input, defaulting the boilerplate. Callers override the
 *  receipt-shape fields (receiptIndices / payments / legacy). */
function input(over: Partial<PlanReceiptPaymentsInput>): PlanReceiptPaymentsInput {
  const idxs = over.receiptIndices ?? [];
  return {
    jobId: JOB,
    receiptIndices: idxs,
    // By default every receipt index has a durable enqueue-time R2 object.
    storedImageKeys: over.storedImageKeys ?? idxs.map((i) => `scan-jobs/${JOB}/${i}`),
    receiptImageKey: over.receiptImageKey ?? null,
    payments: over.payments ?? [],
    legacy: over.legacy ?? {
      depositRm: null,
      approvalCode: null,
      paymentMethodValue: null,
      bankValue: null,
      onlineTypeValue: null,
      installmentPlanValue: null,
    },
    slipDate: over.slipDate ?? null,
    nowMs: over.nowMs ?? NOW,
    todayStr: over.todayStr ?? TODAY,
  };
}

const receipt = (imageIndex: number, amountRm: number | null, extra: Partial<ExtractedPayment> = {}): ExtractedPayment => ({
  imageIndex,
  amountRm,
  approvalCode: null,
  receiptTxnDate: null,
  paymentMethodValue: 'Merchant',
  bankValue: 'MBB',
  onlineTypeValue: null,
  installmentPlanValue: null,
  ...extra,
});

describe('planReceiptPayments — receipt count', () => {
  test('0 receipts → no rows', () => {
    expect(planReceiptPayments(input({ receiptIndices: [] }))).toEqual([]);
  });

  test('1 receipt (per-receipt payments[]) → one row with its own amount, is_deposit, own slip key', () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1],
      payments: [receipt(1, 1500, { approvalCode: '001586' })],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      imageIndex: 1,
      amountCenti: 150000,
      approvalCode: '001586',
      method: 'merchant',
      merchantProvider: 'MBB',
      isDeposit: true,
      slipKey: `scan-jobs/${JOB}/1`,
      paidAt: TODAY,
    });
  });

  test('1 receipt LEGACY (no payments[]) → row falls back to the slip singular deposit — unchanged pre-multi behaviour', () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1],
      payments: [],
      legacy: {
        depositRm: 800,
        approvalCode: '778210',
        paymentMethodValue: 'Cash',
        bankValue: null,
        onlineTypeValue: null,
        installmentPlanValue: null,
      },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountCenti: 80000,
      approvalCode: '778210',
      method: 'cash',
      isDeposit: true,
      slipKey: `scan-jobs/${JOB}/1`,
    });
  });

  test('N receipts → N rows, each its OWN amount; only the first is is_deposit', () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1, 2, 3],
      payments: [
        receipt(1, 1500, { approvalCode: 'A1', bankValue: 'MBB' }),
        receipt(2, 3200, { approvalCode: 'A2', bankValue: 'Public' }),
        receipt(3, 500, { approvalCode: 'A3', paymentMethodValue: 'Cash', bankValue: null }),
      ],
    }));
    expect(rows.map((r) => r.amountCenti)).toEqual([150000, 320000, 50000]);
    expect(rows.map((r) => r.isDeposit)).toEqual([true, false, false]);
    expect(rows.map((r) => r.approvalCode)).toEqual(['A1', 'A2', 'A3']);
    expect(rows.map((r) => r.merchantProvider)).toEqual(['MBB', 'Public', null]);
    expect(rows.map((r) => r.method)).toEqual(['merchant', 'merchant', 'cash']);
    expect(rows.map((r) => r.slipKey)).toEqual([
      `scan-jobs/${JOB}/1`, `scan-jobs/${JOB}/2`, `scan-jobs/${JOB}/3`,
    ]);
  });

  test('a receipt with no readable amount books NOTHING (no RM0 phantom row)', () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1, 2],
      payments: [receipt(1, 2000), receipt(2, null)],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].imageIndex).toBe(1);
  });

  test('LEGACY with extra receipts: only the first books (the singular deposit); extras have no amount', () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1, 2],
      payments: [],
      legacy: {
        depositRm: 1200,
        approvalCode: null,
        paymentMethodValue: 'Merchant',
        bankValue: 'CIMB',
        onlineTypeValue: null,
        installmentPlanValue: '12 months',
      },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCenti: 120000, isDeposit: true, installmentMonths: 12, merchantProvider: 'CIMB' });
  });

  test('first receipt slip key falls back to receiptImageKey when the enqueue-time put failed', () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1],
      storedImageKeys: [],            // enqueue-time R2 put failed → no scan-jobs key
      receiptImageKey: 'scan-slips/s1-receipt',
      payments: [receipt(1, 900)],
    }));
    expect(rows[0].slipKey).toBe('scan-slips/s1-receipt');
  });

  test("the receipt's own printed transaction date drives paidAt; an out-of-window date clamps to today", () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1, 2],
      payments: [
        receipt(1, 100, { receiptTxnDate: '2026-07-15' }),   // in window
        receipt(2, 200, { receiptTxnDate: '2015-09-17' }),   // absurd past → today
      ],
    }));
    expect(rows[0].paidAt).toBe('2026-07-15');
    expect(rows[1].paidAt).toBe(TODAY);
  });

  /* THREE DIFFERENT DATES, and only two of them may ever reach paid_at. The
     card terminal's printed transaction date is the money date and wins; the
     SLIP'S OWN written date is the fallback when a receipt printed none. The
     Sales Order's Processing Date (internal_expected_dd) is a THIRD fact and is
     not an input to this planner at all — it never appears in
     PlanReceiptPaymentsInput, which is the point of the rename. */
  test("the slip's own date is the fallback only, and never beats the receipt's", () => {
    const rows = planReceiptPayments(input({
      receiptIndices: [1, 2],
      slipDate: '2026-07-10',
      payments: [
        receipt(1, 100, { receiptTxnDate: '2026-07-15' }), // receipt printed one → it wins
        receipt(2, 200, { receiptTxnDate: null }),         // none printed → slip date
      ],
    }));
    expect(rows[0].paidAt).toBe('2026-07-15');
    expect(rows[1].paidAt).toBe('2026-07-10');
  });
});

describe('deriveLedgerMethod', () => {
  test('cash', () => {
    expect(deriveLedgerMethod({ paymentMethodValue: 'Cash', bankValue: null, onlineTypeValue: null, installmentPlanValue: null }))
      .toMatchObject({ method: 'cash', guessed: false });
  });
  test('online → transfer with sub-type', () => {
    expect(deriveLedgerMethod({ paymentMethodValue: 'Online', bankValue: null, onlineTypeValue: 'DuitNow', installmentPlanValue: null }))
      .toMatchObject({ method: 'transfer', onlineType: 'DuitNow', guessed: false });
  });
  test('merchant with a tenure', () => {
    expect(deriveLedgerMethod({ paymentMethodValue: 'Merchant', bankValue: 'MBB', onlineTypeValue: null, installmentPlanValue: '12 months' }))
      .toMatchObject({ method: 'merchant', merchantProvider: 'MBB', installmentMonths: 12, guessed: false });
  });
  test('unreadable method → assume Merchant, flagged guessed', () => {
    expect(deriveLedgerMethod({ paymentMethodValue: null, bankValue: null, onlineTypeValue: null, installmentPlanValue: null }))
      .toMatchObject({ method: 'merchant', guessed: true });
  });
});

describe('resolvePaidAt', () => {
  test('a plausible in-window date is trusted', () => {
    expect(resolvePaidAt('2026-07-10', NOW, TODAY)).toBe('2026-07-10');
  });
  test('an absurd past year clamps to today', () => {
    expect(resolvePaidAt('2015-09-17', NOW, TODAY)).toBe(TODAY);
  });
  test('a far-future date clamps to today', () => {
    expect(resolvePaidAt('2027-01-01', NOW, TODAY)).toBe(TODAY);
  });
  test('non-date text clamps to today', () => {
    expect(resolvePaidAt('after CNY', NOW, TODAY)).toBe(TODAY);
    expect(resolvePaidAt(null, NOW, TODAY)).toBe(TODAY);
  });
});

describe('installmentPlanToMonths', () => {
  test('N months → N', () => expect(installmentPlanToMonths('12 months')).toBe(12));
  test('One Shot → null', () => expect(installmentPlanToMonths('One Shot')).toBeNull());
  test('blank → null', () => expect(installmentPlanToMonths(null)).toBeNull());
});
