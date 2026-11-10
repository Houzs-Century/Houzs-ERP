import { describe, expect, it, vi } from 'vitest';
import { deferMrpSnapshotRefresh, isDefaultMrpView, MRP_REFRESH_COMPANY_IDS } from '../src/scm/lib/mrp-snapshot';

const { computeMrp } = vi.hoisted(() => ({ computeMrp: vi.fn() }));
vi.mock('../src/scm/routes/mrp', () => ({ computeMrp }));
vi.mock('../src/services/agents/procurement-learning', () => ({
  loadLeadBuffers: async () => ({ supplierBufferDays: {}, seasonBufferDays: {} }),
}));

/* The snapshot is served ONLY for the exact params it was computed with (no
   category/warehouse filter, undated hidden) — catFilter/whFilter change the
   allocation inputs, not just the output rows, so a stored full result cannot be
   post-filtered. isDefaultMrpView is the gate that keeps that correct. */
describe('isDefaultMrpView', () => {
  it('is true ONLY for the default view (no filters, undated hidden)', () => {
    expect(isDefaultMrpView(null, null, false)).toBe(true);
  });

  it('is false when any filter or the undated toggle is active', () => {
    expect(isDefaultMrpView('SOFA', null, false)).toBe(false);   // category filter
    expect(isDefaultMrpView(null, 'wh-1', false)).toBe(false);   // warehouse filter
    expect(isDefaultMrpView(null, null, true)).toBe(false);      // undated shown
    expect(isDefaultMrpView('SOFA', 'wh-1', true)).toBe(false);  // all three
  });
});

describe('MRP_REFRESH_COMPANY_IDS', () => {
  it('covers the two live tenants', () => {
    expect([...MRP_REFRESH_COMPANY_IDS].sort()).toEqual([1, 2]);
  });
});

describe('deferMrpSnapshotRefresh', () => {
  function ctx() {
    const waited: Promise<unknown>[] = [];
    const upserts: Array<Record<string, unknown>> = [];
    const tables: string[] = [];
    const sb = { from: (t: string) => ({ upsert: async (row: Record<string, unknown>) => { tables.push(t); upserts.push(row); return { error: null }; } }) };
    const c = { env: { DB: {} }, executionCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) } };
    return { c, sb, waited, upserts, tables };
  }

  it('recomputes and stores the page view and the list view for a cron-refreshed company', async () => {
    computeMrp.mockReset().mockResolvedValue({ skus: [], sofaSets: [] });
    const { c, sb, waited, upserts, tables } = ctx();
    deferMrpSnapshotRefresh(c, sb, 2, 'po-cancel');
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(computeMrp.mock.calls[0][1]).toMatchObject({ catFilter: null, whFilter: null, includeUndated: false, companyId: 2 });
    expect(computeMrp.mock.calls[1][1]).toMatchObject({ catFilter: null, whFilter: null, includeUndated: true, companyId: 2 });
    expect(upserts).toHaveLength(2);
    expect(tables).toEqual(['mrp_snapshots', 'mrp_list_snapshots']);
    expect(upserts[0]).toMatchObject({ company_id: 2, result: { skus: [], sofaSets: [] } });
    expect(upserts[1]).toMatchObject({ company_id: 2, result: { skus: [], sofaSets: [] } });
  });

  it('never seeds a snapshot for a company the cron does not keep fresh', () => {
    computeMrp.mockReset();
    const { c, sb, waited } = ctx();
    deferMrpSnapshotRefresh(c, sb, 99, 'po-cancel');
    expect(waited).toHaveLength(0);
    expect(computeMrp).not.toHaveBeenCalled();
  });

  it('a failed recompute is swallowed and stores nothing', async () => {
    computeMrp.mockReset().mockRejectedValue(new Error('boom'));
    const { c, sb, waited, upserts } = ctx();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    deferMrpSnapshotRefresh(c, sb, 1, 'po-cancel');
    await expect(waited[0]).resolves.toBeUndefined();
    expect(upserts).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
