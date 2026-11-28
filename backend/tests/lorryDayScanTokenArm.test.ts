/* Arming the QR on a packing list printed per lorry per delivery day (no trip),
   on the real route over fake PostgREST: every DO id must be this company's, a
   re-print of the same set gets the same token, a different set gets a new one. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { tripScanToken } from '../src/scm/routes/trip-scan-token';
import { DO_SCAN_TOKEN_RE } from '../src/scm/lib/do-scan-token';
import { lorryDayMovedReason, packingSheetTitle, parseLorryDaySheet } from '../src/scm/lib/lorry-day-scan';

const CO = 1;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

function harness(company: number | null = CO) {
  const sb = fakeSb({
    delivery_orders: [
      { id: A, company_id: CO, do_number: 'HC-DO-1', status: 'LOADED' },
      { id: B, company_id: CO, do_number: 'HC-DO-2', status: 'LOADED' },
      { id: FOREIGN, company_id: 2, do_number: '2990-DO-9', status: 'LOADED' },
    ],
    packing_scan_sets: [],
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
  const arm = (q: Record<string, string>) =>
    app.request(`/trips/lorry-day-scan-token?${new URLSearchParams(q).toString()}`, {}, {});
  return { arm, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

describe('arming a lorry-day packing list QR', () => {
  test('mints a token holding the printed DOs, in sheet order, for this company', async () => {
    const h = harness();
    const res = await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: `${B},${A}` });
    expect(res.status).toBe(200);
    const { scanToken } = await res.json() as { scanToken: string };
    expect(DO_SCAN_TOKEN_RE.test(scanToken)).toBe(true);
    expect(h.tables.packing_scan_sets).toHaveLength(1);
    expect(h.tables.packing_scan_sets[0]).toMatchObject({
      company_id: CO, lorry_plate: 'VJK 8821', delivery_date: '2026-11-28', do_ids: [B, A], qr_token: scanToken,
      created_by: 'staff-1',
    });
  });

  test('a re-print of the same set gets the same token; a different set gets a new one', async () => {
    const h = harness();
    const one = await (await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: `${A},${B}` })).json() as any;
    const again = await (await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: `${B},${A}` })).json() as any;
    expect(again.scanToken).toBe(one.scanToken);
    expect(h.tables.packing_scan_sets).toHaveLength(1);
    const other = await (await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: A })).json() as any;
    expect(other.scanToken).not.toBe(one.scanToken);
    expect(h.tables.packing_scan_sets).toHaveLength(2);
  });

  test('a revoked sheet is not reused', async () => {
    const h = harness();
    const one = await (await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: A })).json() as any;
    h.tables.packing_scan_sets[0]!.qr_revoked_at = '2026-11-28T01:00:00Z';
    const two = await (await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: A })).json() as any;
    expect(two.scanToken).not.toBe(one.scanToken);
  });

  test('another company\'s DO id refuses the whole sheet and mints nothing', async () => {
    const h = harness();
    const res = await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: `${A},${FOREIGN}` });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.doIds).toEqual([FOREIGN]);
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });

  test('a DO id that does not exist is refused too', async () => {
    const h = harness();
    const res = await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: '44444444-4444-4444-8444-444444444444' });
    expect(res.status).toBe(404);
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });

  test('no active company: refused, nothing written', async () => {
    const h = harness(null);
    const res = await h.arm({ plate: 'VJK 8821', date: '2026-11-28', doIds: A });
    expect(res.status).toBe(409);
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });

  test.each([
    [{ plate: '', date: '2026-11-28', doIds: A }],
    [{ plate: 'VJK 8821', date: '28/11/2026', doIds: A }],
    [{ plate: 'VJK 8821', date: '2026-11-28', doIds: 'not-a-uuid' }],
    [{ plate: 'VJK 8821', date: '2026-11-28', doIds: '' }],
  ])('a malformed request is a 400: %o', async (q) => {
    const h = harness();
    expect((await h.arm(q)).status).toBe(400);
    expect(h.tables.packing_scan_sets).toHaveLength(0);
  });
});

describe('the pure parts', () => {
  test('the scan page names a split sheet by its part', () => {
    expect(packingSheetTitle({ sheetKind: 'lorry', lorryPlate: 'VJK 8821', region: null, part: null })).toBe('Lorry VJK 8821');
    expect(packingSheetTitle({ sheetKind: 'region', lorryPlate: null, region: 'KL', part: { no: 2, count: 3 } })).toBe('Region KL · Part 2 of 3');
    expect(parseLorryDaySheet({ lorryPlate: 'X1', deliveryDate: '2026-11-28', doIds: [A], part: '2', parts: '3' }))
      .toMatchObject({ ok: true, sheet: { part: { no: 2, count: 3 } } });
  });

  test('parseLorryDaySheet keeps sheet order, drops duplicates, caps at 60', () => {
    const ok = parseLorryDaySheet({ lorryPlate: ' VJK 8821 ', deliveryDate: '2026-11-28', doIds: [B, A, B.toUpperCase()] });
    expect(ok).toEqual({ ok: true, sheet: { lorryPlate: 'VJK 8821', deliveryDate: '2026-11-28', doIds: [B, A], part: null } });
    const many = Array.from({ length: 61 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(parseLorryDaySheet({ lorryPlate: 'X1', deliveryDate: '2026-11-28', doIds: many }).ok).toBe(false);
  });

  test('a DO has moved when its crew plate (else vehicle) is not the printed plate', () => {
    expect(lorryDayMovedReason('VJK 8821', 'vjk-8821', null)).toBeNull();
    expect(lorryDayMovedReason('VJK 8821', null, 'VJK8821')).toBeNull();
    expect(lorryDayMovedReason('VJK 8821', 'WXY 1234', 'VJK 8821')).toContain('another lorry');
    expect(lorryDayMovedReason('VJK 8821', null, null)).toContain('Taken off');
  });
});

describe('the public route can never mint', () => {
  test('publicDoScan.ts does not reach the lorry-day minter', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/routes/publicDoScan.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('mintLorryDayScanToken');
  });
});
