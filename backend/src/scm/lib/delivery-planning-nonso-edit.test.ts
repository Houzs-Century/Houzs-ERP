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

  // HC-0193: the pickup row and the service-delivery row of one case keep separate statuses.
  it('writes the message status to the named leg column only', async () => {
    const { c, runs } = fakeCtx();
    await writeNonSoFields(c, {}, 'assr', '7', { deliveryMessageStatus: 'Done Send', jobKind: 'customer_pickup' });
    await writeNonSoFields(c, {}, 'assr', '7', { deliveryMessageStatus: 'To Send Driver Info', jobKind: 'delivery' });
    expect(runs[0]!.sql).toContain('pickup_message_status = ?');
    expect(runs[0]!.sql).not.toContain('delivery_message_status');
    expect(runs[1]!.sql).toContain('delivery_message_status = ?');
    expect(runs[1]!.sql).not.toContain('pickup_message_status');
    expect((await writeNonSoFields(c, {}, 'assr', '7', { deliveryMessageStatus: 'Done Send' })).status).toBe(400);
  });

  it('refuses a slot with no leg, and blanks an empty one to null', async () => {
    const { c, runs } = fakeCtx();
    expect((await writeNonSoFields(c, {}, 'assr', '7', { timeRange: '2-4pm' })).status).toBe(400);
    await writeNonSoFields(c, {}, 'assr', '7', { timeRange: '', jobKind: 'delivery' });
    expect(runs[0]!.binds).toEqual([null, 7]);
  });
});

// HC-0193 re-test (ASSR/2610-024): the SERVICE job's POD closed the case, the PICKUP job is still open.
describe('writeNonSoFields (closed case, open sibling job)', () => {
  const closedCase: Record<string, unknown> = { id: 7, stage: 'completed', actual_pickup_at: null, closed_at: '2026-10-31 14:30:00', status: 'Completed' };
  function closedCtx(row: Record<string, unknown> = closedCase) {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const prepare = (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => row,
        run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
      }),
    });
    return { c: { env: { DB: { prepare } }, get: () => undefined }, runs };
  }

  it('saves the pickup job while the POD closed service job stays untouched', async () => {
    const { c, runs } = closedCtx();
    const pickup = await writeNonSoFields(c, {}, 'assr', '7', { deliveryMessageStatus: 'Done Send', jobKind: 'customer_pickup' });
    expect(pickup.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain('pickup_message_status = ?');
    expect(runs[0]!.sql).not.toContain('delivery_message_status');
    expect(runs[0]!.sql).not.toContain('closed_at');
    const service = await writeNonSoFields(c, {}, 'assr', '7', { deliveryMessageStatus: 'Done Send', jobKind: 'delivery' });
    expect(service.status).toBe(404);
    expect(runs).toHaveLength(1);
  });

  it('refuses a pickup that was itself done', async () => {
    const { c, runs } = closedCtx({ ...closedCase, actual_pickup_at: '2026-10-29' });
    const r = await writeNonSoFields(c, {}, 'assr', '7', { timeRange: '2-4pm', jobKind: 'customer_pickup' });
    expect(r.status).toBe(404);
    expect(runs).toHaveLength(0);
  });
});
