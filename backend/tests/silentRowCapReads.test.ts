// Reads that used to stop silently at PostgREST's 1,000-row reply (or a hard
// .limit()) and hand the user a wrong answer with no error.
//
// Every fake client here has the server's ceiling (maxRows = 1,000) and is fed
// more rows than that. Each read must still see all of them, or say plainly
// that it could not.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { chunkIn, paginateAll, PAGE } from '../src/scm/lib/paginate-all';
import { loadRemarkFlags } from '../src/scm/routes/delivery-remarks';
import { latestFixPerLorry } from '../src/scm/routes/lorries';
import { loadJobProgressSince } from '../src/scm/routes/delivery-job-progress';
import { soPoLockedMany } from '../src/scm/lib/so-po-lock';
import { soConvertedPos } from '../src/scm/lib/so-converted-po';
import { kmByLorryForRange, KM_MAX_DAYS, daysInRange } from '../src/scm/lib/lorry-km-range';
import { kmFromFixes } from '../src/scm/lib/lorry-km';
import { deliverDueShippedOrders } from '../src/scm/lib/deliver-due-shipped';
import { deliveredUninvoiced } from '../src/scm/lib/auto-final-invoice';
import { loadAssrChatState } from '../src/scm/lib/assr-arrangement-message';
import { loadKnownPurchaseCostSen } from '../src/scm/lib/zero-cost-receipt-guard';

const CEILING = 1000;
const capped = (tables: Record<string, Row[]>) => fakeSb(tables, {}, [], [], CEILING);
const pad = (n: number, w = 5) => String(n).padStart(w, '0');

/** A client whose every page is full: the read can never reach a short page. */
function endlessSb() {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'order', 'in', 'filter']) builder[m] = () => builder;
  builder.range = (from: number, to: number) => Promise.resolve({
    data: Array.from({ length: to - from + 1 }, (_, i) => ({ lorry_id: 'L1', lat: 3, lng: 101, recorded_at: new Date(Date.UTC(2026, 9, 20) + (from + i) * 1000).toISOString() })),
    error: null,
  });
  return { from: () => builder };
}

describe('paginateAll / chunkIn report a stop at the page guard', () => {
  test('a read that only ever gets full pages comes back truncated, not silently short', async () => {
    const r = await paginateAll((from, to) => Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => from + i), error: null }));
    expect(r.truncated).toBe(true);
    expect(r.data).toHaveLength(50 * PAGE);
  });

  test('a read that ends on a short page is complete', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    const r = await paginateAll((from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }));
    expect(r).toEqual({ data: rows, error: null, truncated: false });
  });

  test('chunkIn carries a batch\'s truncation out', async () => {
    const r = await chunkIn(['a', 'b'], (_b, from, to) => Promise.resolve({ data: Array.from({ length: to - from + 1 }, () => 1), error: null }));
    expect(r.truncated).toBe(true);
  });
});

describe('/delivery-remarks/flags', () => {
  test('every order with a remark keeps its pill past 1,000 remarks', async () => {
    const remarks: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, so_doc_no: `SO-${pad(i % 1200)}` }));
    const r = await loadRemarkFlags(capped({ delivery_remarks: remarks }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.flags).toHaveLength(1200);
    expect(r.flags.reduce((n, f) => n + f.count, 0)).toBe(1500);
    expect(r.flags.find((f) => f.soDocNo === 'SO-01199')).toEqual({ soDocNo: 'SO-01199', count: 1 });
  });
});

describe('/lorries/positions/latest', () => {
  test('a lorry parked since the morning stays on the map behind 1,200 newer fixes', async () => {
    const now = Date.UTC(2026, 10, 10, 12);
    const fixes: Row[] = [];
    for (let i = 0; i < 1200; i++) {
      fixes.push({ id: `f${pad(i)}`, lorry_id: ['A', 'B', 'C', 'D'][i % 4], lat: 3, lng: 101, speed_kmh: 40, heading: 0, ignition: true, street: null, recorded_at: new Date(now - i * 60_000).toISOString(), received_at: null });
    }
    fixes.push({ id: 'parked', lorry_id: 'E', lat: 3.1, lng: 101.1, speed_kmh: 0, heading: 0, ignition: false, street: 'Depot', recorded_at: new Date(now - 23 * 3600_000).toISOString(), received_at: null });
    const r = await latestFixPerLorry(capped({ lorry_positions: fixes }), new Date(now - 24 * 3600_000).toISOString());
    expect(r.error).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.data.map((f) => f.lorry_id).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(r.data.find((f) => f.lorry_id === 'A')!.recorded_at).toBe(new Date(now).toISOString());
  });
});

describe('/delivery-jobs/progress', () => {
  test('1,500 legs in the window all come back (the old .limit(5000) gave 1,000)', async () => {
    const rows: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: `jp${pad(i)}`, company_id: 1, source_type: 'dp', source_id: String(i), leg: 'delivery', updated_at: '2026-11-01T00:00:00Z' }));
    rows.push({ id: 'other-co', company_id: 2, source_type: 'dp', source_id: 'x', leg: 'delivery', updated_at: '2026-11-01T00:00:00Z' });
    rows.push({ id: 'no-co', company_id: null, source_type: 'project', source_id: 'p', leg: 'setup', updated_at: '2026-11-01T00:00:00Z' });
    const r = await loadJobProgressSince(capped({ job_progress: rows }), '2026-10-01', [1]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.rows).toHaveLength(1501); // company 1 plus the company-less leg; never company 2
    expect(r.rows.some((x) => x.source_id === 'x')).toBe(false);
  });
});

/** 200 orders x 6 lines = 1,200 SO lines; the PO sits on the LAST order's last line. */
function soWithPoOnLastLine() {
  const docs = Array.from({ length: 200 }, (_, i) => `SO-${pad(i)}`);
  const lines: Row[] = [];
  docs.forEach((doc, d) => { for (let l = 0; l < 6; l++) lines.push({ id: `li-${pad(d)}-${l}`, doc_no: doc, company_id: 1 }); });
  return {
    docs,
    tables: {
      mfg_sales_order_items: lines,
      purchase_order_items: [{ id: 'poi-1', so_item_id: 'li-00199-5', purchase_order_id: 'po-1', company_id: 1 }],
      purchase_orders: [{ id: 'po-1', po_number: 'PO-0001', status: 'DRAFT', company_id: 1 }],
    } as Record<string, Row[]>,
  };
}

describe('soPoLockedMany / soConvertedPos', () => {
  test('an order whose lines fall past the first 1,000 still shows as PO-locked', async () => {
    const { docs, tables } = soWithPoOnLastLine();
    const locked = await soPoLockedMany(capped(tables), docs);
    expect([...locked]).toEqual(['SO-00199']);
  });

  test('an order whose lines fall past the first 1,000 still lists its PO', async () => {
    const { docs, tables } = soWithPoOnLastLine();
    const pos = await soConvertedPos(capped(tables), docs, 1);
    expect(pos.get('SO-00199')).toEqual([{ id: 'po-1', po_number: 'PO-0001' }]);
  });
});

describe('Lorry Capacity GPS km', () => {
  /* Two Malaysia days, 1,400 fixes each for one lorry moving 0.01 deg of
     latitude every 5 minutes, so each day alone passes the 1,000-row reply. */
  function twoDays() {
    const fixes: Row[] = [];
    const perDay: Row[][] = [[], []];
    for (const [d, day] of ['2026-11-01', '2026-11-02'].entries()) {
      const start = Date.parse(`${day}T00:00:00+08:00`);
      for (let i = 0; i < 1400; i++) {
        const f = { id: `${day}-${pad(i)}`, lorry_id: 'L1', lat: 3 + (i % 2) * 0.01, lng: 101, recorded_at: new Date(start + i * 60_000).toISOString() };
        fixes.push(f);
        perDay[d]!.push(f);
      }
    }
    return { fixes, perDay };
  }

  test('km over the range counts every fix of every day', async () => {
    const { fixes, perDay } = twoDays();
    const r = await kmByLorryForRange(capped({ lorry_positions: fixes }), '2026-11-01', '2026-11-02');
    if (!r.ok || r.km === null) throw new Error('expected km');
    const expected = Math.round((kmFromFixes(perDay[0] as never) + kmFromFixes(perDay[1] as never)) * 10) / 10;
    expect(expected).toBeGreaterThan(0);
    expect(r.km.get('L1')).toBe(expected);
  });

  test('a range longer than the limit gives no km and says why', async () => {
    expect(daysInRange('2026-01-01', '2026-03-31').length).toBeGreaterThan(KM_MAX_DAYS);
    const r = await kmByLorryForRange(capped({ lorry_positions: [] }), '2026-01-01', '2026-03-31');
    expect(r).toMatchObject({ ok: true, km: null });
  });

  test('a day that hits the page guard gives no km rather than a short one', async () => {
    const r = await kmByLorryForRange(endlessSb(), '2026-11-01', '2026-11-01');
    expect(r).toMatchObject({ ok: true, km: null });
    if (r.ok && r.km === null) expect(r.incomplete).toContain('2026-11-01');
  });
});

describe('deliverDueShippedOrders', () => {
  test('scans every SHIPPED order, not the first 1,000', async () => {
    const sos: Row[] = Array.from({ length: 1500 }, (_, i) => ({ doc_no: `SO-${pad(i)}`, company_id: 1, status: 'SHIPPED', customer_state: 'Selangor', customer_country: 'Malaysia' }));
    const r = await deliverDueShippedOrders(capped({ mfg_sales_orders: sos, delivery_orders: [] }), '2026-11-10', null);
    expect(r).toEqual({ scanned: 1500, delivered: 0, skipped: 1500 });
  });
});

describe('deliveredUninvoiced', () => {
  test('the backlog reaches orders past the first 1,000, and invoices past 1,000 still count', async () => {
    const sos: Row[] = [];
    const invoices: Row[] = [];
    for (let i = 0; i < 1200; i++) {
      sos.push({ doc_no: `SO-${pad(i)}`, company_id: 2, status: 'DELIVERED' });
      if (i !== 1150) invoices.push({ id: `si-${pad(i)}`, so_doc_no: `SO-${pad(i)}`, company_id: 2, status: 'POSTED' });
    }
    const r = await deliveredUninvoiced(capped({ mfg_sales_orders: sos, sales_invoices: invoices, delivery_orders: [] }) as never, 2);
    expect(r).toEqual({ ok: true, orders: [{ docNo: 'SO-01150', deliveredOn: null }] });
  });
});

describe('loadAssrChatState', () => {
  test('a case whose only send is older than 1,200 newer rows keeps its state', async () => {
    const log: Row[] = [];
    for (let i = 0; i < 1200; i++) log.push({ id: `w${pad(i)}`, doc_no: 'assr:1:delivery', source: 'delivery-planning', success: true, payload: '{}', created_at: new Date(Date.UTC(2026, 10, 9) + i * 1000).toISOString() });
    log.push({ id: 'old', doc_no: 'assr:2:delivery', source: 'delivery-planning', success: true, payload: '{}', created_at: '2026-10-01T00:00:00Z' });
    const state = await loadAssrChatState(capped({ wa_message_log: log }) as never, ['assr:1:delivery', 'assr:2:delivery']);
    expect(state.get('assr:2:delivery')?.delivery_message_status).toBe('Done Send');
  });
});

describe('loadKnownPurchaseCostSen', () => {
  test('a code with an older priced lot is still known behind 1,200 newer lots of another code', async () => {
    const lots: Row[] = Array.from({ length: 1200 }, (_, i) => ({ id: `lot${pad(i)}`, item_code: 'BUSY', unit_cost_sen: 500, received_at: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(), company_id: 1 }));
    lots.push({ id: 'quiet', item_code: 'QUIET', unit_cost_sen: 777, received_at: '2026-01-01T00:00:00Z', company_id: 1 });
    const known = await loadKnownPurchaseCostSen(capped({ inventory_lots: lots }), ['BUSY', 'QUIET'], 1);
    expect(known.get('QUIET')).toBe(777);
    expect(known.get('BUSY')).toBe(500);
  });
});
