import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { tripScanToken } from '../src/scm/routes/trip-scan-token';
import { parseRegionDaySheet } from '../src/scm/lib/lorry-day-scan';
import {
  aggregatePackingScanStatus,
  checkPackingScanStep,
  fmtMalaysiaTime,
  nextPackingScanStep,
  type PackingScanSetRow,
} from '../src/scm/lib/packing-scan-steps';

const CO = 1;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

function harness(sets: Row[] = [], company: number | null = CO) {
  const sb = fakeSb({
    delivery_orders: [
      { id: A, company_id: CO, do_number: 'HC-DO-1', status: 'LOADED' },
      { id: B, company_id: CO, do_number: 'HC-DO-2', status: 'LOADED' },
      { id: FOREIGN, company_id: 2, do_number: '2990-DO-9', status: 'LOADED' },
    ],
    packing_scan_sets: sets,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, company as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('user' as never, { id: 'staff-1' } as never);
    await next();
  });
  app.route('/trips', tripScanToken as unknown as Hono);
  const get = (path: string, q: Record<string, string>) =>
    app.request(`/trips/${path}?${new URLSearchParams(q).toString()}`, {}, {});
  return { get, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

describe('which scan comes next', () => {
  test('prepared first, then loaded, then nothing', () => {
    expect(nextPackingScanStep(null, null)).toBe('prepare');
    expect(nextPackingScanStep('2026-11-28T01:00:00Z', null)).toBe('load');
    expect(nextPackingScanStep('2026-11-28T01:00:00Z', '2026-11-28T02:00:00Z')).toBe('done');
  });

  test('the pressed step must match the sheet, bar a double tap on prepared', () => {
    const P = '2026-11-28T01:00:00Z';
    const L = '2026-11-28T02:00:00Z';
    expect(checkPackingScanStep('prepare', null, null, null)).toEqual({ ok: true, step: 'prepare', already: false });
    expect(checkPackingScanStep('prepare', null, P, null)).toEqual({ ok: true, step: 'prepare', already: true });
    expect(checkPackingScanStep('load', null, P, null)).toEqual({ ok: true, step: 'load', already: false });
    expect(checkPackingScanStep('load', null, null, null)).toMatchObject({ ok: false, status: 409, code: 'stale_step' });
    expect(checkPackingScanStep('load', null, P, L)).toMatchObject({ ok: false, status: 409 });
    expect(checkPackingScanStep('prepare', null, P, L)).toMatchObject({ ok: false, status: 409 });
    expect(checkPackingScanStep('ship', null, null, null)).toMatchObject({ ok: false, status: 400 });
    expect(checkPackingScanStep(undefined, null, P, null)).toMatchObject({ ok: false, status: 400 });
  });

  test('an old page that sends to: DISPATCHED is read as a load', () => {
    expect(checkPackingScanStep(undefined, 'DISPATCHED', '2026-11-28T01:00:00Z', null))
      .toEqual({ ok: true, step: 'load', already: false });
    expect(checkPackingScanStep(undefined, 'DISPATCHED', null, null)).toMatchObject({ ok: false, status: 409 });
    expect(checkPackingScanStep(undefined, 'IN_TRANSIT', '2026-11-28T01:00:00Z', null)).toMatchObject({ ok: false, status: 400 });
  });

  test('times print in Malaysia time', () => {
    expect(fmtMalaysiaTime('2026-11-28T01:42:00Z')).toBe('2026/11/28 09:42');
    expect(fmtMalaysiaTime('2026-11-28T17:05:00Z')).toBe('2026/11/29 01:05');
    expect(fmtMalaysiaTime(null)).toBe('');
    expect(fmtMalaysiaTime('nonsense')).toBe('');
  });
});

describe('the day status, folded per lorry and per region', () => {
  const row = (r: Partial<PackingScanSetRow>): PackingScanSetRow => ({
    sheet_kind: 'lorry', lorry_plate: null, region: null, prepared_at: null, loaded_at: null, qr_revoked_at: null,
    part_no: null, part_count: null, created_at: '2026-11-28T00:00:00Z', ...r,
  });

  test('a lorry printed twice reports the earliest prepared and the latest loaded time', () => {
    const out = aggregatePackingScanStatus([
      row({ lorry_plate: 'VJK 8821', prepared_at: '2026-11-28T02:00:00Z', loaded_at: '2026-11-28T03:00:00Z' }),
      row({ lorry_plate: 'vjk-8821', prepared_at: '2026-11-28T01:00:00Z', loaded_at: '2026-11-28T04:00:00Z' }),
      row({ lorry_plate: 'VJK8821', prepared_at: null, loaded_at: null }),
    ]);
    expect(out).toEqual([
      { kind: 'lorry', key: 'VJK8821', prepared_at: '2026-11-28T01:00:00Z', loaded_at: '2026-11-28T04:00:00Z', parts_total: 1, parts_prepared: 1, parts_loaded: 1 },
    ]);
  });

  test('a lorry in two parts has a time only once both parts have one, and then the later one', () => {
    const p = (no: number, prepared: string | null, loaded: string | null) =>
      row({ lorry_plate: 'VJK 8821', part_no: no, part_count: 2, prepared_at: prepared, loaded_at: loaded, created_at: '2026-11-28T00:10:00Z' });
    expect(aggregatePackingScanStatus([p(1, '2026-11-28T01:00:00Z', '2026-11-28T03:00:00Z'), p(2, null, null)])).toEqual([
      { kind: 'lorry', key: 'VJK8821', prepared_at: null, loaded_at: null, parts_total: 2, parts_prepared: 1, parts_loaded: 1 },
    ]);
    expect(aggregatePackingScanStatus([p(1, '2026-11-28T01:00:00Z', '2026-11-28T03:00:00Z'), p(2, '2026-11-28T02:00:00Z', null)])).toEqual([
      { kind: 'lorry', key: 'VJK8821', prepared_at: '2026-11-28T02:00:00Z', loaded_at: null, parts_total: 2, parts_prepared: 2, parts_loaded: 1 },
    ]);
    expect(aggregatePackingScanStatus([p(2, '2026-11-28T02:00:00Z', '2026-11-28T04:00:00Z'), p(1, '2026-11-28T01:00:00Z', '2026-11-28T03:00:00Z')])[0])
      .toMatchObject({ prepared_at: '2026-11-28T02:00:00Z', loaded_at: '2026-11-28T04:00:00Z', parts_loaded: 2 });
  });

  test('the newest print decides the shape: a whole sheet re-printed as two parts waits for both parts', () => {
    const out = aggregatePackingScanStatus([
      row({ lorry_plate: 'VJK 8821', prepared_at: '2026-11-28T01:00:00Z', created_at: '2026-11-28T00:00:00Z' }),
      row({ lorry_plate: 'VJK 8821', part_no: 1, part_count: 2, prepared_at: '2026-11-28T02:00:00Z', created_at: '2026-11-28T01:30:00Z' }),
      row({ lorry_plate: 'VJK 8821', part_no: 2, part_count: 2, created_at: '2026-11-28T01:30:00Z' }),
    ]);
    expect(out).toEqual([{ kind: 'lorry', key: 'VJK8821', prepared_at: null, loaded_at: null, parts_total: 2, parts_prepared: 1, parts_loaded: 0 }]);
  });

  test('regions and lorries are separate lines; revoked and keyless sheets are ignored', () => {
    const out = aggregatePackingScanStatus([
      row({ sheet_kind: 'region', region: 'KL', prepared_at: '2026-11-28T01:00:00Z' }),
      row({ sheet_kind: 'region', region: 'KL', prepared_at: '2026-11-28T00:10:00Z', qr_revoked_at: '2026-11-28T00:20:00Z' }),
      row({ lorry_plate: 'KL', loaded_at: null }),
      row({ lorry_plate: '  ' }),
    ]);
    expect(out).toEqual([
      { kind: 'region', key: 'KL', prepared_at: '2026-11-28T01:00:00Z', loaded_at: null, parts_total: 1, parts_prepared: 1, parts_loaded: 0 },
      { kind: 'lorry', key: 'KL', prepared_at: null, loaded_at: null, parts_total: 1, parts_prepared: 0, parts_loaded: 0 },
    ]);
  });
});

describe('arming a region packing list QR', () => {
  test('mints a region sheet for this company and reuses it on a re-print of the same set', async () => {
    const h = harness();
    const one = await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: `${B},${A}` });
    expect(one.status).toBe(200);
    const { scanToken } = await one.json() as { scanToken: string };
    expect(h.tables.packing_scan_sets[0]).toMatchObject({
      company_id: CO, sheet_kind: 'region', region: 'KL', lorry_plate: null, do_ids: [B, A], qr_token: scanToken,
    });
    const again = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: `${A},${B}` })).json() as any;
    expect(again.scanToken).toBe(scanToken);
    expect(h.tables.packing_scan_sets).toHaveLength(1);
  });

  test('a re-print keeps the recorded times; a changed DO set gets a new token beside it', async () => {
    const h = harness();
    const one = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: `${A},${B}` })).json() as any;
    h.tables.packing_scan_sets[0]!.prepared_at = '2026-11-28T01:00:00Z';
    const again = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: `${B},${A}` })).json() as any;
    expect(again.scanToken).toBe(one.scanToken);
    expect(h.tables.packing_scan_sets).toHaveLength(1);
    expect(h.tables.packing_scan_sets[0]!.prepared_at).toBe('2026-11-28T01:00:00Z');
    const changed = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: A })).json() as any;
    expect(changed.scanToken).not.toBe(one.scanToken);
    expect(h.tables.packing_scan_sets).toHaveLength(2);
  });

  test('each part of a split sheet gets its own token and records which part it is', async () => {
    const h = harness();
    const p1 = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: A, part: '1', parts: '2' })).json() as any;
    const p2 = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: B, part: '2', parts: '2' })).json() as any;
    expect(p1.scanToken).not.toBe(p2.scanToken);
    expect(h.tables.packing_scan_sets.map((r) => [r.part_no, r.part_count])).toEqual([[1, 2], [2, 2]]);
    const again = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: A, part: '1', parts: '2' })).json() as any;
    expect(again.scanToken).toBe(p1.scanToken);
    const whole = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: A })).json() as any;
    expect(whole.scanToken).not.toBe(p1.scanToken);
    expect(h.tables.packing_scan_sets.at(-1)).toMatchObject({ part_no: null, part_count: null });
  });

  test('a bad part number is a 400 and mints nothing', async () => {
    const h = harness();
    for (const q of [{ part: '3', parts: '2' }, { part: '1', parts: '1' }, { part: '1' }, { part: 'x', parts: '2' }, { part: '0', parts: '2' }]) {
      expect((await h.get('lorry-day-scan-token', { plate: 'VJK 8821', date: '2026-11-28', doIds: A, ...q })).status).toBe(400);
    }
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });

  test('a lorry sheet with the same DOs is not reused for a region (and back)', async () => {
    const h = harness();
    const lorry = await (await h.get('lorry-day-scan-token', { plate: 'KL', date: '2026-11-28', doIds: A })).json() as any;
    const region = await (await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: A })).json() as any;
    expect(region.scanToken).not.toBe(lorry.scanToken);
    expect(h.tables.packing_scan_sets.map((r) => r.sheet_kind)).toEqual(['lorry', 'region']);
  });

  test('another company\'s DO refuses the whole region sheet', async () => {
    const h = harness();
    const res = await h.get('region-day-scan-token', { region: 'KL', date: '2026-11-28', doIds: `${A},${FOREIGN}` });
    expect(res.status).toBe(404);
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });

  test('no region, or over 60 DOs, is a 400 and mints nothing', async () => {
    const h = harness();
    expect((await h.get('region-day-scan-token', { region: ' ', date: '2026-11-28', doIds: A })).status).toBe(400);
    const many = Array.from({ length: 61 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(parseRegionDaySheet({ region: 'KL', deliveryDate: '2026-11-28', doIds: many }).ok).toBe(false);
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });
});

describe('the office reads the day\'s scan times', () => {
  test('only this company\'s sheets of that date, folded per lorry and region', async () => {
    const h = harness([
      { company_id: CO, sheet_kind: 'lorry', lorry_plate: 'VJK 8821', region: null, delivery_date: '2026-11-28', prepared_at: '2026-11-28T01:00:00Z', loaded_at: null, qr_revoked_at: null },
      { company_id: CO, sheet_kind: 'region', lorry_plate: null, region: 'KL', delivery_date: '2026-11-28', prepared_at: '2026-11-28T00:50:00Z', loaded_at: '2026-11-28T02:00:00Z', qr_revoked_at: null },
      { company_id: 2, sheet_kind: 'lorry', lorry_plate: 'OTHER 1', region: null, delivery_date: '2026-11-28', prepared_at: '2026-11-28T01:00:00Z', loaded_at: null, qr_revoked_at: null },
      { company_id: CO, sheet_kind: 'lorry', lorry_plate: 'WXY 1', region: null, delivery_date: '2026-11-27', prepared_at: '2026-11-27T01:00:00Z', loaded_at: null, qr_revoked_at: null },
    ]);
    const res = await h.get('packing-scan-status', { date: '2026-11-28' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sheets).toEqual([
      { kind: 'lorry', key: 'VJK8821', prepared_at: '2026-11-28T01:00:00Z', loaded_at: null, parts_total: 1, parts_prepared: 1, parts_loaded: 0 },
      { kind: 'region', key: 'KL', prepared_at: '2026-11-28T00:50:00Z', loaded_at: '2026-11-28T02:00:00Z', parts_total: 1, parts_prepared: 1, parts_loaded: 1 },
    ]);
  });

  test('a bad date is a 400; no company is a 409', async () => {
    expect((await harness().get('packing-scan-status', { date: '28/11/2026' })).status).toBe(400);
    expect((await harness([], null).get('packing-scan-status', { date: '2026-11-28' })).status).toBe(409);
  });
});
