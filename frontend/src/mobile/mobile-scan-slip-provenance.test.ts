/* A slip scanned on the phone must produce an order that CARRIES the slip.

   ── THE BUG ────────────────────────────────────────────────────────────────
   `/scan-so/extract` answers with `imageKey` + `receiptImageKey` — the R2 keys
   of the photos it just read — and `MobileScan.buildPrefill` dropped both, so
   the client-side draft create (`createDraftFromPrefill`) sent neither. Desktop
   carries them (`SalesOrderNew` → `slipImageKey` / `receiptImageKey`, stored by
   the create handler as `slip_image_key` / `receipt_image_key`), and
   `MobileSODetail` already renders a "Scanned photos" card off exactly those
   columns — permanently empty for a phone-scanned order.

   ── HONEST SCOPE ───────────────────────────────────────────────────────────
   The PRIMARY mobile path is `POST /scan-so/enqueue`, where the draft is minted
   SERVER-side and `backend/src/scm/routes/scan-so.ts` already sets both keys on
   the create body. The gap is the CLIENT-side path — `submitLegacy`, taken when
   `/enqueue` answers 404 from a stale worker — which re-implements the same
   create and lost the provenance on the way. That is the desktop-vs-mobile
   re-implementation this fixes; it is not "every phone scan". */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const authedFetchMock = vi.fn();
vi.mock('../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (...args: unknown[]) => authedFetchMock(...args),
  API_URL: 'http://test',
}));

import { createDraftFromPrefill } from './MobileNewSO';
import type { MobileScanPrefill } from './MobileScan';

const prefill = (over: Partial<MobileScanPrefill> = {}): MobileScanPrefill => ({
  name: 'Lim Ah Kau',
  phone: '123456789',
  emergencyPhone: '',
  address1: '',
  state: '',
  city: '',
  postcode: '',
  custRef: '',
  note: '',
  deliveryDate: '',
  slipDate: '',
  customerType: '',
  buildingType: '',
  venue: '',
  payment: null,
  payments: [],
  lines: [],
  sampleId: null,
  salesperson: null,
  slipImageKey: 'scan-slips/abc',
  receiptImageKey: 'scan-receipts/def',
  aiOriginal: {} as MobileScanPrefill['aiOriginal'],
  ...over,
});

const bodyOfLastPost = (): Record<string, unknown> => {
  const call = authedFetchMock.mock.calls.at(-1);
  expect(call, 'createDraftFromPrefill never POSTed').toBeTruthy();
  const init = call![1] as { body?: string };
  return JSON.parse(String(init.body)) as Record<string, unknown>;
};

describe('createDraftFromPrefill carries the scan provenance', () => {
  beforeEach(() => {
    authedFetchMock.mockReset();
    authedFetchMock.mockResolvedValue({ docNo: 'HC-SO-2608-001' });
  });

  test('the slip photo and the receipt photo ride the create body', async () => {
    await createDraftFromPrefill(prefill());
    const body = bodyOfLastPost();
    expect(body.slipImageKey).toBe('scan-slips/abc');
    expect(body.receiptImageKey).toBe('scan-receipts/def');
  });

  test('a scan with no receipt photo sends no receipt key — never an empty string', () => {
    /* The create handler stores `body.receiptImageKey ?? null`; an empty string
       would be stored verbatim and the detail card would try to fetch "". */
    return createDraftFromPrefill(prefill({ receiptImageKey: null })).then(() => {
      const body = bodyOfLastPost();
      expect(body.slipImageKey).toBe('scan-slips/abc');
      expect('receiptImageKey' in body ? body.receiptImageKey : undefined).toBeUndefined();
    });
  });

  test('a prefill with no photos at all still creates the draft', async () => {
    await expect(
      createDraftFromPrefill(prefill({ slipImageKey: null, receiptImageKey: null })),
    ).resolves.toBe('HC-SO-2608-001');
    const body = bodyOfLastPost();
    expect('slipImageKey' in body ? body.slipImageKey : undefined).toBeUndefined();
  });
});
