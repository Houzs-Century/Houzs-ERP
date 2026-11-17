import { describe, it, expect } from 'vitest';
import { labelAuditIds } from '../src/scm/lib/audit-id-labels';

const SUP = 'd930541c-297b-4a8c-93e0-53a1d1cce34d';
const WH = '24f982eb-b19f-45da-ba05-97ceb7a9d0e4';
const PO = '2a8b462d-ce92-4392-835a-4957b868b392';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

function stub(tables: Record<string, Array<Record<string, unknown>>>, fail: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, ids: string[]) {
              calls.push(table);
              if (fail.includes(table)) return Promise.resolve({ data: null, error: { message: 'boom' } });
              return Promise.resolve({ data: (tables[table] ?? []).filter((r) => ids.includes(r.id as string)), error: null });
            },
          };
        },
      };
    },
  };
}

describe('labelAuditIds — the History drawer names a record instead of printing its id', () => {
  it('labels supplier, warehouse and PO ids on a GRN create (the owner screenshot, 2026-11-17)', async () => {
    const entries = [{ field_changes: [
      { field: 'status', to: 'POSTED' },
      { field: 'supplierId', to: SUP },
      { field: 'purchaseOrderId', to: PO },
      { field: 'warehouseId', to: WH },
    ] }];
    const sb = stub({
      suppliers: [{ id: SUP, code: '400-N001', name: 'NICE FUTURE MARKETING SDN. BHD.' }],
      purchase_orders: [{ id: PO, po_number: 'HC-PO-2611-001' }],
      warehouses: [{ id: WH, code: 'KL', name: 'KL WAREHOUSE' }],
    });
    expect(await labelAuditIds(sb, entries)).toEqual([]);
    const fc = entries[0].field_changes as Array<Record<string, unknown>>;
    expect(fc[1].to_label).toBe('400-N001 · NICE FUTURE MARKETING SDN. BHD.');
    expect(fc[2].to_label).toBe('HC-PO-2611-001');
    expect(fc[3].to_label).toBe('KL WAREHOUSE');
    expect(fc[1].to).toBe(SUP);
    expect(fc[0].to_label).toBeUndefined();
  });

  it('labels both sides of a change and an array of staff', async () => {
    const entries = [{ field_changes: [
      { field: 'salespersonId', from: S1, to: S2 },
      { field: 'collaboratorStaffIds', from: [S1], to: [S1, S2] },
    ] }];
    const sb = stub({ staff: [{ id: S1, name: 'Ethan' }, { id: S2, name: 'Fong' }] });
    await labelAuditIds(sb, entries);
    const fc = entries[0].field_changes as Array<Record<string, unknown>>;
    expect([fc[0].from_label, fc[0].to_label]).toEqual(['Ethan', 'Fong']);
    expect(fc[1].to_label).toBe('Ethan, Fong');
    expect(sb.calls).toEqual(['staff']);
  });

  it('leaves an id it cannot find as it is, and reports a table it could not read', async () => {
    const entries = [{ field_changes: [
      { field: 'supplierId', to: SUP },
      { field: 'warehouseId', to: WH },
    ] }];
    const failed = await labelAuditIds(stub({ suppliers: [] }, ['warehouses']), entries);
    expect(failed).toEqual(['warehouses']);
    const fc = entries[0].field_changes as Array<Record<string, unknown>>;
    expect(fc[0].to_label).toBeUndefined();
    expect(fc[1].to_label).toBeUndefined();
  });

  it('reads nothing when no change names a record', async () => {
    const sb = stub({});
    await labelAuditIds(sb, [{ field_changes: [{ field: 'status', to: 'POSTED' }] }, { field_changes: null }]);
    expect(sb.calls).toEqual([]);
  });
});
