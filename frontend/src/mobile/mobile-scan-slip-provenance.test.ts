
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
