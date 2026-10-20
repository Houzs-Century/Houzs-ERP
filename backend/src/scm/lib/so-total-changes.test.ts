import { describe, expect, it } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { changeSourceOf, recordSoTotalChange, snapshotSoTotals } from './so-total-changes';

/* The upsales / drop sales Event Commission lists come from these rows (owner
   2026-10-20): one per change of an order's goods or total, written where the
   header is rolled up. */

const ctx = (path: string | null, name = 'Siti') =>
  path == null ? null : { req: { path }, get: (k: string) => (k === 'houzsUser' ? { name } : undefined) };

const world = () => fakeSb({
  mfg_sales_orders: [{ doc_no: 'HC-SO-2610-001', company_id: 1, mattress_sofa_sen: 800_00, bedframe_sen: 200_00, accessories_sen: 0, others_sen: 0, local_total_sen: 1_100_00 }],
  so_total_changes: [],
});

describe('so total changes', () => {
  it('reads the goods as the four goods buckets — the fee and services are not goods', async () => {
    expect(await snapshotSoTotals(world(), 'HC-SO-2610-001')).toEqual({ companyId: 1, goodsSen: 1_000_00, totalSen: 1_100_00 });
    expect(await snapshotSoTotals(world(), 'HC-SO-NOPE')).toBeNull();
  });

  it('records a change with who and what kind of request; records nothing when nothing moved', async () => {
    const sb = world();
    const before = await snapshotSoTotals(sb, 'HC-SO-2610-001');
    await recordSoTotalChange(sb, ctx('/api/scm/mfg-sales-orders/HC-SO-2610-001/items/x'), 'HC-SO-2610-001', before, { goodsSen: 1_000_00, totalSen: 1_100_00 });
    expect(sb.tables.so_total_changes).toHaveLength(0);
    await recordSoTotalChange(sb, ctx('/api/scm/mfg-sales-orders/HC-SO-2610-001/amendments/a1/approve'), 'HC-SO-2610-001', before, { goodsSen: 1_250_00, totalSen: 1_350_00 });
    expect(sb.tables.so_total_changes[0]).toMatchObject({
      company_id: 1, so_doc_no: 'HC-SO-2610-001', before_goods_sen: 1_000_00, after_goods_sen: 1_250_00,
      before_total_sen: 1_100_00, after_total_sen: 1_350_00, source: 'amendment', changed_by: 'Siti',
    });
  });

  it('names the request: an amendment path, any other path an edit, no request the system', () => {
    expect(changeSourceOf(ctx('/api/scm/mfg-sales-orders/X/amendments/1/approve'))).toBe('amendment');
    expect(changeSourceOf(ctx('/api/scm/mfg-sales-orders/X/items/1'))).toBe('edit');
    expect(changeSourceOf(ctx(null))).toBe('system');
  });

  it('an unread header records nothing rather than a change from zero', async () => {
    const sb = world();
    await recordSoTotalChange(sb, ctx('/x'), 'HC-SO-2610-001', null, { goodsSen: 5, totalSen: 5 });
    expect(sb.tables.so_total_changes).toHaveLength(0);
  });
});
