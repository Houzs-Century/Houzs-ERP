import { describe, expect, test, vi } from 'vitest';

const armPackingScanToken = vi.fn(async (_tripId: string) => 'trip-token');
const armLorryDayScanToken = vi.fn(async (_input: { lorryPlate: string; deliveryDate: string; doIds: readonly string[] }) => 'day-token');
const armRegionDayScanToken = vi.fn(async (_input: { region: string; deliveryDate: string; doIds: readonly string[] }): Promise<string | null> => 'region-token');
vi.mock('./packing-scan-token-arm', () => ({ armPackingScanToken, armLorryDayScanToken, armRegionDayScanToken }));
vi.mock('./authed-fetch', () => ({ authedFetch: async () => { throw new Error('offline in tests'); } }));

import type { PackingStop } from './packing-list-queries';

const stop = (stop_no: number, do_id: string | null): PackingStop => ({
  stop_no, stop_type: 'DELIVERY', customer_name: null, address: null, do_id, do_number: null, do_status: null,
  do_missing: false, so_doc_no: null, phone: null, time_range: null, units: 0, items: [],
});

/* Owner 2026-11-27: "the QR, scanned, means the whole lorry is loaded". Most
   lorries come from the board crew and have no trip, so their sheet arms a
   lorry-day token over the DOs printed on it, in sheet (loading) order. */
describe('packing-list QR target', () => {
  test('a trip sheet arms the trip token', async () => {
    const { runUrlFor } = await import('./packing-list-pdf');
    const url = await runUrlFor({ source: 'trip', trip_id: 'T1', lorry_plate: 'VJK 8821', trip_date: '2026-11-28', stops: [] }, '2026-11-28');
    expect(armPackingScanToken).toHaveBeenCalledWith('T1');
    expect(url).toBe(`${window.location.origin}/d/trip-token`);
  });

  test('a crew lorry arms a lorry-day token over its printed DOs, last stop first', async () => {
    const { runUrlFor } = await import('./packing-list-pdf');
    const url = await runUrlFor({
      source: 'crew', trip_id: 'crew:VPC9058', lorry_plate: ' VPC9058 ', trip_date: null,
      stops: [stop(1, 'do-a'), stop(3, 'do-c'), stop(2, null)],
    }, '2026-11-28');
    expect(armLorryDayScanToken).toHaveBeenCalledWith({ lorryPlate: 'VPC9058', deliveryDate: '2026-11-28', doIds: ['do-c', 'do-a'] });
    expect(url).toBe(`${window.location.origin}/d/day-token`);
  });

  test('no plate or no DO prints no QR', async () => {
    const { runUrlFor } = await import('./packing-list-pdf');
    armLorryDayScanToken.mockClear();
    expect(await runUrlFor({ source: 'crew', trip_id: 'x', lorry_plate: '', trip_date: null, stops: [stop(1, 'do-a')] }, '2026-11-28')).toBeNull();
    expect(await runUrlFor({ source: 'crew', trip_id: 'x', lorry_plate: 'VPC9058', trip_date: null, stops: [stop(1, null)] }, '2026-11-28')).toBeNull();
    expect(armLorryDayScanToken).not.toHaveBeenCalled();
  });
});

describe('region sheet QR target (owner 2026-11-28)', () => {
  test('a region arms a region-day token over its printed DOs, in sheet order', async () => {
    const { regionRunUrlFor } = await import('./packing-list-pdf');
    const url = await regionRunUrlFor({ region: 'KL', dos: [{ do_id: 'do-b' }, { do_id: 'do-a' }] }, '2026-11-28');
    expect(armRegionDayScanToken).toHaveBeenCalledWith({ region: 'KL', deliveryDate: '2026-11-28', doIds: ['do-b', 'do-a'] });
    expect(url).toBe(`${window.location.origin}/d/region-token`);
  });

  test('no region key or no DO prints no QR', async () => {
    const { regionRunUrlFor } = await import('./packing-list-pdf');
    armRegionDayScanToken.mockClear();
    expect(await regionRunUrlFor({ region: ' ', dos: [{ do_id: 'do-a' }] }, '2026-11-28')).toBeNull();
    expect(await regionRunUrlFor({ region: 'KL', dos: [] }, '2026-11-28')).toBeNull();
    expect(armRegionDayScanToken).not.toHaveBeenCalled();
  });

  test('a failed arm prints no QR', async () => {
    const { regionRunUrlFor } = await import('./packing-list-pdf');
    armRegionDayScanToken.mockResolvedValueOnce(null);
    expect(await regionRunUrlFor({ region: 'KL', dos: [{ do_id: 'do-a' }] }, '2026-11-28')).toBeNull();
  });
});
