import { describe, expect, it } from 'vitest';
import { loadDrops, shapeDrops } from '../src/scm/lib/lorry-drops';

describe('shapeDrops', () => {
  it('lists a delivered DO with no GPS unpinned, skips a job with no GPS, labels, and orders by time', () => {
    const out = shapeDrops(
      [
        { id: 'd1', do_number: 'DO-1', debtor_name: 'Ali', pod_lat: 3.1, pod_lng: 101.6, pod_located_at: '2026-11-20T04:00:00Z', delivered_at: null },
        { id: 'd2', do_number: 'DO-2', debtor_name: null, pod_lat: null, pod_lng: null, pod_located_at: null, delivered_at: '2026-11-20T05:00:00Z' },
      ],
      [
        { source_type: 'project', source_id: '9', leg: 'SETUP', pod_lat: 3.2, pod_lng: 101.7, pod_located_at: null, completed_at: '2026-11-20T02:00:00Z' },
        { source_type: 'project', source_id: '8', leg: 'SETUP', pod_lat: null, pod_lng: null, pod_located_at: null, completed_at: '2026-11-20T03:00:00Z' },
      ],
      new Map([['d1', 's1']]),
    );
    expect(out.map((d) => [d.kind, d.label, d.lat, d.stopId])).toEqual([['job', 'SETUP 9', 3.2, null], ['do', 'DO-1 - Ali', 3.1, 's1'], ['do', 'DO-2', null, null]]);
  });
});

/* A chainable fake: records every filter per table and resolves to that table's rows. */
function fakeDb(rows: Record<string, unknown[]>, failOn: string | null) {
  const calls: Record<string, string[]> = {};
  const sb = {
    from(table: string) {
      calls[table] = [];
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'not']) {
        q[m] = (col: string) => { calls[table]!.push(`${m}:${col}`); return q; };
      }
      q.then = (ok: (v: unknown) => void) => ok(table === failOn
        ? { data: null, error: { message: `${table} down` } }
        : { data: rows[table] ?? [], error: null });
      return q;
    },
  };
  return { sb, calls };
}

const ctx = { get: (k: string) => (k === 'allowedCompanyIds' ? [1] : undefined) };
const ROWS = {
  trips: [{ id: 't1' }],
  trip_stops: [{ id: 's1', do_id: 'd1' }],
  job_progress: [],
  delivery_orders: [{ id: 'd1', do_number: 'DO-1', debtor_name: 'Ali', pod_lat: 3.1, pod_lng: 101.6, pod_located_at: '2026-11-20T04:00:00Z', delivered_at: null }],
};

describe('loadDrops', () => {
  it('filters every company-data read by the allowed companies', async () => {
    const { sb, calls } = fakeDb(ROWS, null);
    const out = await loadDrops(sb, ctx, 'l1', '2026-11-20');
    expect(out).toEqual({ drops: [expect.objectContaining({ ref: 'd1', stopId: 's1' })], error: null });
    for (const t of ['trips', 'trip_stops', 'job_progress', 'delivery_orders']) expect(calls[t]).toContain('in:company_id');
  });

  it('turns a failed read into an error, not a crash', async () => {
    const { sb } = fakeDb(ROWS, 'delivery_orders');
    expect(await loadDrops(sb, ctx, 'l1', '2026-11-20')).toEqual({ drops: [], error: 'delivery_orders down' });
  });
});
