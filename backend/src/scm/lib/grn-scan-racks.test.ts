// Sim, 2026-10-20: the warehouse handwrites the rack beside each delivery-order
// row ("R11-2"); the scanned draft should carry it instead of being picked line
// by line. Racks as on production KL / SRW WAREHOUSE ("Rack L1.1" .. "Rack R17.2").
import { describe, expect, test } from 'vitest';
import { normalizeGrnExtract } from './grn-scan-extract';
import { matchGrnScanToPoLines, type OpenPoLine, type ScannedGrnLine } from './grn-scan-match';
import { applyScanRacks, rackKey, resolveRack, scanRackNote } from './grn-scan-racks';

const KL = ['Rack L8.1', 'Rack L17.2', 'Rack L19.2', 'Rack R5.1', 'Rack R6.1', 'Rack R7.1', 'Rack R7.2', 'Rack R8.1', 'Rack R9.1', 'Rack R11.2', 'Rack R1.12']
  .map((rack, i) => ({ id: `rk-${i}`, rack }));

describe('rackKey', () => {
  test('reads the ways the warehouse writes it and our labels alike', () => {
    expect(rackKey('R7-2')).toBe('R7.2');
    expect(rackKey('R:11-2')).toBe('R11.2');
    expect(rackKey('L-19-2')).toBe('L19.2');
    expect(rackKey('l 8.1')).toBe('L8.1');
    expect(rackKey('Rack L19.2')).toBe('L19.2');
  });
  test('anything else is not a rack', () => {
    expect(rackKey('SERVICE')).toBeNull();
    expect(rackKey('HC-SO-013339')).toBeNull();
    expect(rackKey('R11')).toBeNull();
    expect(rackKey(null)).toBeNull();
  });
});

describe('resolveRack', () => {
  test('a written rack names the one shelf of that warehouse', () => {
    expect(resolveRack('R11-2', KL)?.rack).toBe('Rack R11.2');
    expect(resolveRack('L-19-2', KL)?.rack).toBe('Rack L19.2');
  });
  test('R11-2 never lands on R1.12, nor a rack the warehouse does not have', () => {
    expect(resolveRack('R11-2', KL)?.rack).not.toBe('Rack R1.12');
    expect(resolveRack('R99-1', KL)).toBeNull();
    expect(resolveRack('R7-2', KL.filter((r) => r.rack !== 'Rack R7.2'))).toBeNull();
  });
});

describe('the scanner keeps the handwritten rack per row', () => {
  test('normalizeGrnExtract reads it, blank is null', () => {
    const out = normalizeGrnExtract({ lines: [{ itemCode: '1007-(SS)', qty: 1, rack: ' R11-2 ' }, { itemCode: 'X', qty: 1, rack: '' }] });
    expect(out.lines.map((l) => l.rack)).toEqual(['R11-2', null]);
  });
});

// DO-2610-074 (Hookka, 2026-10-19) as handwritten: R7-2 TRION, R6-1 JAGER (K),
// L8-1 JAGER (Q) after R7-1 was crossed out, one bracket "L-19-2" over the three
// 5530 sofa rows, nothing on the 5540-1A(RHF) row.
describe('a matched row hands its rack to the PO line (DO-2610-074)', () => {
  const line = (n: string, po: string, itemCode: string): OpenPoLine => ({
    poItemId: n, poId: po, poNumber: po, supplierId: 'hookka', itemCode, materialName: null, supplierSku: null, remaining: 1, locationCode: 'KL WAREHOUSE',
  });
  const open = [
    line('trion', 'HC-PO-2610-136', 'TRION (A) (HB STR)-(K)'),
    line('jagerk', 'HC-PO-2610-177', 'JAGER-(K)'),
    line('jagerq', 'HC-PO-2610-216', 'JAGER-(Q)'),
    line('s1', 'HC-PO-2609-272', '9028-1A(LHF)'),
    line('s2', 'HC-PO-2609-272', '9028-1NA'),
    line('rhf', 'HC-PO-2609-273', '8030-1A(RHF)'),
  ];
  const row = (itemCode: string, poNo: string, rack: string | null): ScannedGrnLine => ({ itemCode, barcode: null, description: null, qty: 1, poNo, rack });

  test('each picked line carries the rack written on its row; no rack, no entry', () => {
    const res = matchGrnScanToPoLines(null, [
      row('TRION (A) (HB STR)-(K)', 'HC-PO-2610-136', 'R7-2'),
      row('JAGER-(K)', 'HC-PO-2610-177', 'R6-1'),
      row('JAGER-(Q)', 'HC-PO-2610-216', 'L8-1'),
      row('9028-1A(LHF)', 'HC-PO-2609-272', 'L-19-2'),
      row('9028-1NA', 'HC-PO-2609-272', 'L-19-2'),
      row('8030-1A(RHF)', 'HC-PO-2609-273', null),
    ], open, [], 'hookka');
    expect(res.picks).toHaveLength(6);
    expect(res.racks).toEqual({ trion: 'R7-2', jagerk: 'R6-1', jagerq: 'L8-1', s1: 'L-19-2', s2: 'L-19-2' });
  });

  test('two rows with different racks onto one line leave it blank', () => {
    const two = [{ ...open[1], remaining: 2 }];
    const res = matchGrnScanToPoLines(null, [row('JAGER-(K)', 'HC-PO-2610-177', 'R6-1'), row('JAGER-(K)', 'HC-PO-2610-177', 'R9-1')], two, [], 'hookka');
    expect(res.picks).toEqual([{ poItemId: 'jagerk', qty: 2 }]);
    expect(res.racks).toEqual({});
  });
});

describe('scanRackNote', () => {
  test('says how many were filled and which to pick', () => {
    expect(scanRackNote({ written: 3, filled: 2, unknown: [{ written: 'R99-1', itemCode: 'CODY-(K)' }], failed: false }))
      .toBe('Racks from the delivery order: 2 of 3 lines filled, check them before posting. Not a rack of this warehouse, please pick: R99-1 (CODY-(K)).');
  });
  test('no handwritten rack, no note', () => {
    expect(scanRackNote({ written: 0, filled: 0, unknown: [], failed: false })).toBeNull();
  });
});

// A just-enough supabase fake: select / in / eq filter rows, update records the patch.
type Row = Record<string, unknown>;
function fakeSvc(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; id: unknown; patch: Row }> = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const q = {
      select: () => q,
      update: (p: Row) => { patch = p; return q; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; },
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return q; },
      then: (resolve: (v: { data: Row[] | null; error: null }) => void) => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (patch) { for (const r of rows) { Object.assign(r, patch); updates.push({ table, id: r.id, patch }); } resolve({ data: null, error: null }); return; }
        resolve({ data: rows, error: null });
      },
    };
    return q;
  };
  return { svc: { from } as unknown as Parameters<typeof applyScanRacks>[0], updates };
}

describe('applyScanRacks', () => {
  const tables = () => ({
    grns: [
      { id: 'g1', company_id: 1, warehouse_id: 'kl', status: 'DRAFT' },
      { id: 'g2', company_id: 1, warehouse_id: 'srw', status: 'POSTED' },
    ],
    grn_items: [
      { id: 'i1', company_id: 1, grn_id: 'g1', purchase_order_item_id: 'p1', item_code: 'TRION', rack_id: null },
      { id: 'i2', company_id: 1, grn_id: 'g1', purchase_order_item_id: 'p2', item_code: 'CODY-(K)', rack_id: null },
      { id: 'i3', company_id: 1, grn_id: 'g1', purchase_order_item_id: 'p3', item_code: 'JAGER', rack_id: 'kept' },
      { id: 'i4', company_id: 1, grn_id: 'g2', purchase_order_item_id: 'p4', item_code: 'CODY-(SS)', rack_id: null },
    ],
    warehouse_racks: [
      { id: 'kl-r72', company_id: 1, warehouse_id: 'kl', rack: 'Rack R7.2' },
      { id: 'kl-r61', company_id: 1, warehouse_id: 'kl', rack: 'Rack R6.1' },
      { id: 'srw-r112', company_id: 1, warehouse_id: 'srw', rack: 'Rack R11.2' },
      { id: 'other-co', company_id: 2, warehouse_id: 'kl', rack: 'Rack R99.1' },
    ],
  });

  test('fills a DRAFT line from its own warehouse, leaves unknown and already-set lines alone', async () => {
    const t = tables();
    const { svc, updates } = fakeSvc(t);
    const res = await applyScanRacks(svc, 1, ['g1', 'g2'], { p1: 'R7-2', p2: 'R99-1', p3: 'R6-1', p4: 'R11-2' });
    expect(updates).toEqual([{ table: 'grn_items', id: 'i1', patch: { rack_id: 'kl-r72' } }]);
    expect(res).toEqual({ written: 3, filled: 1, unknown: [{ written: 'R99-1', itemCode: 'CODY-(K)' }], failed: false });
  });

  test('nothing written, nothing read', async () => {
    const { svc, updates } = fakeSvc(tables());
    expect(await applyScanRacks(svc, 1, ['g1'], {})).toEqual({ written: 0, filled: 0, unknown: [], failed: false });
    expect(updates).toEqual([]);
  });
});
