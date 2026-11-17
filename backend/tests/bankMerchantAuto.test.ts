// Owner 2026-11-17, on 2990's Hong Leong RM 615 for 14/11 — its QR line already
// linked on Merchant Recon, the bank still waiting for a Match: 他应该和 merchant
// 一样我只要对一边，只是如果银行实际收到的钱同个 merchant report 还有没有对上的才应该卡着.
// Which credits match themselves (acc/bank-merchant-auto); the doors they go
// through are pinned in bankQrCredit.test.ts and bankRoutes.test.ts.
import { describe, expect, test } from 'vitest';
import { merchantAgreedActions, type AgreedLine } from '../src/acc/bank-merchant-auto';

const line = (over: Partial<AgreedLine> & { id: number }): AgreedLine => ({
  amountSen: 61500, kind: 'OTHER', matchedBatchId: null, split: null, byAdvice: false, qr: null, ...over,
});

describe('which bank credits the merchant side already accounts for', () => {
  test('a READY QR credit is matched to its sales; one still waiting for a link is not', () => {
    expect(merchantAgreedActions([
      line({ id: 1, kind: 'QR', qr: { ready: true, jeNos: ['2990-JE-2611-0430'] } }),
      line({ id: 2, kind: 'QR', qr: { ready: false, jeNos: [] } }),
    ], [])).toEqual([{ kind: 'qr', lineId: 1, jeNos: ['2990-JE-2611-0430'] }]);
  });

  test('a payout tied to one report for exactly what it is still owed is booked; any other amount waits', () => {
    const batches = [{ id: 7, outstandingSen: 61500 }, { id: 8, outstandingSen: 99900 }];
    expect(merchantAgreedActions([
      line({ id: 1, kind: 'PAYOUT', matchedBatchId: 7 }),
      /* The bank kept a charge: less than the report is owed — a person names it. */
      line({ id: 2, kind: 'PAYOUT', matchedBatchId: 8, amountSen: 99400 }),
    ], batches)).toEqual([{ kind: 'payout', lineId: 1, allocations: [{ batchId: 7, amountSen: 61500 }] }]);
  });

  test('a split found by amounts adding up, an unsure payout, a report not offered (lines still to confirm) and a transfer all wait', () => {
    expect(merchantAgreedActions([
      line({ id: 1, kind: 'PAYOUT_SPLIT', split: [{ batchId: 7, amountSen: 61500 }, { batchId: 9, amountSen: 0 }] }),
      line({ id: 2, kind: 'PAYOUT_UNSURE', matchedBatchId: 7 }),
      line({ id: 3, kind: 'PAYOUT', matchedBatchId: 42 }),
      line({ id: 4, kind: 'OTHER' }),
      line({ id: 5, kind: 'PAYOUT', matchedBatchId: 7, amountSen: 0 }),
    ], [{ id: 7, outstandingSen: 61500 }])).toEqual([]);
  });

  test('one report is paid by one credit, and one entry claimed by one credit', () => {
    expect(merchantAgreedActions([
      line({ id: 1, kind: 'PAYOUT', matchedBatchId: 7 }),
      line({ id: 2, kind: 'PAYOUT', matchedBatchId: 7 }),
      line({ id: 3, kind: 'QR', qr: { ready: true, jeNos: ['JE-1', 'JE-2'] } }),
      line({ id: 4, kind: 'QR', qr: { ready: true, jeNos: ['JE-2'] } }),
    ], [{ id: 7, outstandingSen: 61500 }])).toEqual([
      { kind: 'payout', lineId: 1, allocations: [{ batchId: 7, amountSen: 61500 }] },
      { kind: 'qr', lineId: 3, jeNos: ['JE-1', 'JE-2'] },
    ]);
  });

  /* Owner 2026-11-17, choosing A for 2990's PBB RM 20,710.87 of 10/11 — three
     reports (7, 8, 9 Nov) that add up to it, and no advice uploaded for the day. */
  describe('one payout for several reports', () => {
    const reports = [{ id: 7, outstandingSen: 240285 }, { id: 8, outstandingSen: 502363 }, { id: 9, outstandingSen: 1328439 }];
    const split = [{ batchId: 7, amountSen: 240285 }, { batchId: 8, amountSen: 502363 }, { batchId: 9, amountSen: 1328439 }];

    test('is booked across the reports when the payment advice says so', () => {
      expect(merchantAgreedActions([line({ id: 1, kind: 'PAYOUT_SPLIT', amountSen: 2071087, split, byAdvice: true })], reports))
        .toEqual([{ kind: 'payout', lineId: 1, allocations: split }]);
    });

    test('waits for a person when the reports only add up to it', () => {
      expect(merchantAgreedActions([line({ id: 1, kind: 'PAYOUT_SPLIT', amountSen: 2071087, split, byAdvice: false })], reports)).toEqual([]);
    });

    test('waits when a report is owed something else now, or the shares miss the credit', () => {
      expect(merchantAgreedActions([line({ id: 1, kind: 'PAYOUT_SPLIT', amountSen: 2071087, split, byAdvice: true })],
        [reports[0]!, reports[1]!, { id: 9, outstandingSen: 1000000 }])).toEqual([]);
      expect(merchantAgreedActions([line({ id: 1, kind: 'PAYOUT_SPLIT', amountSen: 2071000, split, byAdvice: true })], reports)).toEqual([]);
    });
  });
});
