import { describe, expect, it } from 'vitest';
import { writeNonSoFields } from './delivery-planning-nonso-edit';

// HC-0194: a service case keeps one Time Slot per leg, written to that leg's column.
function fakeCtx() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      first: async () => ({ id: 7, assr_no: 'ASSR/2610-059', company_id: 1 }),
      run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
    }),
  });
  return { c: { env: { DB: { prepare } }, get: () => undefined }, runs };
}

function fakeLog(error: { message: string } | null = null) {
  const rows: Array<Record<string, unknown>> = [];
  return { rows, sb: { from: () => ({ insert: async (row: Record<string, unknown>) => { rows.push(row); return { error }; } }) } };
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
    const { sb } = fakeLog();
    await writeNonSoFields(c, sb, 'assr', '7', { deliveryMessageStatus: 'Done Send', jobKind: 'customer_pickup' });
    await writeNonSoFields(c, sb, 'assr', '7', { deliveryMessageStatus: 'To Send Driver Info', jobKind: 'delivery' });
    expect(runs[0]!.sql).toContain('pickup_message_status = ?');
    expect(runs[0]!.sql).not.toContain('delivery_message_status');
    expect(runs[1]!.sql).toContain('delivery_message_status = ?');
    expect(runs[1]!.sql).not.toContain('pickup_message_status');
    expect((await writeNonSoFields(c, {}, 'assr', '7', { deliveryMessageStatus: 'Done Send' })).status).toBe(400);
  });

  it('logs the status pick under the row key, so it outranks an older send', async () => {
    const { c } = fakeCtx();
    const { sb, rows } = fakeLog();
    await writeNonSoFields(c, sb, 'assr', '7', { deliveryMessageStatus: '', jobKind: 'inspection' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc_no: 'ASSR/2610-059#inspection', source: 'board-status-pick', company_id: 1, payload: '{"status":null}' });
  });

  it('a time slot write logs no status pick', async () => {
    const { c } = fakeCtx();
    const { sb, rows } = fakeLog();
    await writeNonSoFields(c, sb, 'assr', '7', { timeRange: '2-4pm', jobKind: 'delivery' });
    expect(rows).toHaveLength(0);
  });

  it('reports not saved when the pick cannot be logged', async () => {
    const { c } = fakeCtx();
    const { sb } = fakeLog({ message: 'log down' });
    const r = await writeNonSoFields(c, sb, 'assr', '7', { deliveryMessageStatus: 'Done Send', jobKind: 'delivery' });
    expect(r.status).toBe(500);
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

  it('saves the pickup and writes nothing to the service job columns', async () => {
    const { c, runs } = closedCtx();
    const pickup = await writeNonSoFields(c, fakeLog().sb, 'assr', '7', { deliveryMessageStatus: 'Done Send', jobKind: 'customer_pickup' });
    expect(pickup.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain('pickup_message_status = ?');
    expect(runs[0]!.sql).not.toContain('delivery_message_status');
    expect(runs[0]!.sql).not.toContain('closed_at');
    expect(runs[0]!.binds).toEqual(['Done Send', 7]);
  });

  it('still saves the pickup when the pickup itself happened (actual_pickup_at set)', async () => {
    const { c, runs } = closedCtx({ ...closedCase, actual_pickup_at: '2026-10-20' });
    const r = await writeNonSoFields(c, fakeLog().sb, 'assr', '7', { deliveryMessageStatus: 'Done Send', timeRange: '2-4pm', jobKind: 'customer_pickup' });
    expect(r.status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain('pickup_message_status = ?');
    expect(runs[0]!.sql).not.toContain('delivery_message_status');
  });

  it('refuses an archived or out-of-scope case', async () => {
    const prepare = () => ({ bind: () => ({ first: async () => null, run: async () => ({ meta: { changes: 0 } }) }) });
    const r = await writeNonSoFields({ env: { DB: { prepare } }, get: () => undefined }, {}, 'assr', '7', { timeRange: 'x', jobKind: 'customer_pickup' });
    expect(r.status).toBe(404);
  });
});

// Remarks on non-SO rows: a service leg, a DP job and a project each save to their own record.
describe('writeNonSoFields (remarks)', () => {
  it('saves a service-case remark to the named leg column only', async () => {
    const { c, runs } = fakeCtx();
    const r = await writeNonSoFields(c, {}, 'assr', '7', { remark: 'call before', jobKind: 'inspection' });
    expect(r.status).toBe(200);
    expect(runs[0]!.sql).toContain('inspection_remark = ?');
    expect(runs[0]!.sql).not.toContain('delivery_remark');
    expect(runs[0]!.binds).toEqual(['call before', 7]);
  });

  it('saves a DP remark on the DP job, company-bounded', async () => {
    const calls: Array<[string, unknown]> = [];
    const q = {
      update: (patch: unknown) => { calls.push(['update', patch]); return q; },
      eq: (col: string, v: unknown) => { calls.push([`eq:${col}`, v]); return q; },
      in: (col: string, v: unknown) => { calls.push([`in:${col}`, v]); return q; },
      select: () => q,
      maybeSingle: async () => ({ data: { id: 'dp-1' }, error: null }),
    };
    const sb = { from: () => q };
    const r = await writeNonSoFields({ get: () => undefined }, sb, 'dp', 'dp-1', { remark: '' });
    expect(r.status).toBe(200);
    expect(calls[0]![1]).toMatchObject({ remark: null });
  });

  it('saves a project remark on the project, and refuses anything else there', async () => {
    const { c, runs } = fakeCtx();
    const r = await writeNonSoFields(c, {}, 'project', '11', { remark: 'gate code 1234' });
    expect(r.status).toBe(200);
    expect(runs[0]!.sql).toContain('UPDATE projects SET delivery_remark = ?');
    expect(runs[0]!.sql).toContain('archived_at IS NULL');
    expect(runs[0]!.binds).toEqual(['gate code 1234', 11]);
    expect((await writeNonSoFields(c, {}, 'project', '11', { timeRange: '2-4pm' })).status).toBe(400);
    expect((await writeNonSoFields(c, {}, 'project', 'PRJ:11', { remark: 'x' })).status).toBe(400);
  });

  it('bounds the project write to the caller\'s companies, and 404s outside them', async () => {
    const sqls: string[] = [];
    const ctxFor = (allowed: number[]) => ({
      env: { DB: { prepare: (sql: string) => { sqls.push(sql); return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }; } } },
      get: (k: string) => (k === 'allowedCompanyIds' ? allowed : undefined),
    });
    expect((await writeNonSoFields(ctxFor([1]), {}, 'project', '11', { remark: 'x' })).status).toBe(404);
    expect(sqls[0]).toContain('AND company_id IN (1)');
    await writeNonSoFields(ctxFor([]), {}, 'project', '11', { remark: 'x' });
    expect(sqls[1]).toContain('AND 1=0');
  });
});
