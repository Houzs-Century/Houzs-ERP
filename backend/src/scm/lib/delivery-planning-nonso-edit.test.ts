import { describe, expect, it } from 'vitest';
import { writeNonSoFields } from './delivery-planning-nonso-edit';

// HC-0194: a service case keeps one Time Slot per leg, written to that leg's column.
function fakeCtx() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      first: async () => ({ id: 7 }),
      run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
    }),
  });
  return { c: { env: { DB: { prepare } }, get: () => undefined }, runs };
}

describe('writeNonSoFields (assr time slot)', () => {
  it('writes the slot to the named leg column only', async () => {
    const { c, runs } = fakeCtx();
    const r = await writeNonSoFields(c, {}, 'assr', '7', { timeRange: '2-4pm', jobKind: 'customer_pickup' });
    expect(r.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain('pickup_time_range = ?');
    expect(runs[0]!.sql).not.toContain('delivery_time_range');
    expect(runs[0]!.binds).toEqual(['2-4pm', 7]);
  });

  it('refuses a slot with no leg, and blanks an empty one to null', async () => {
    const { c, runs } = fakeCtx();
    expect((await writeNonSoFields(c, {}, 'assr', '7', { timeRange: '2-4pm' })).status).toBe(400);
    await writeNonSoFields(c, {}, 'assr', '7', { timeRange: '', jobKind: 'delivery' });
    expect(runs[0]!.binds).toEqual([null, 7]);
  });
});
