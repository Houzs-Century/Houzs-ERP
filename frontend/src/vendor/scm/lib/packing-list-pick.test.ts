/* Part A of the packing list — PICK BY CATEGORY (owner 2026-11-27).
 *
 * The rules pinned here: the category order and mapping, which categories
 * aggregate and which print one row per piece, sofa grouping by sales order,
 * and the ONE deterministic sort every list uses (「确保sorting功能有要不然每次
 * 很乱」): item code, then variant, then customer highest first, then rack.
 */
import { describe, expect, test } from 'vitest';
import {
  PACK_CATEGORY_ORDER,
  buildPickSections,
  comparePickRows,
  packCategory,
  sortPickRows,
  type PickRow,
} from './packing-list-model';
import type { PackingItem, PackingStop } from './packing-list-queries';

const item = (code: string, group: string | null, qty: number, extra: Partial<PackingItem> = {}): PackingItem => ({
  line_no: 1, item_code: code, description: `${code} description`, qty,
  rack: null, rack_locked: false, po: null, po_locked: false, worked_out: false,
  item_group: group, variants: null, description2: null, so_line_no: null,
  ...extra,
});

const stop = (stop_no: number, items: PackingItem[], extra: Partial<PackingStop> = {}): PackingStop => ({
  stop_no, stop_type: 'DELIVERY', customer_name: `Customer ${stop_no}`, address: 'Addr',
  do_id: `do-${stop_no}`, do_number: `DO-${stop_no}`, do_status: 'LOADED', do_missing: false,
  so_doc_no: `SO-${stop_no}`, phone: null, time_range: null,
  units: items.reduce((n, i) => n + i.qty, 0), items, ...extra,
});

const variantFromD2 = (it: PackingItem): string => it.description2 ?? '';

describe('sofa accessories go with their sofa (owner 2026-11-28)', () => {
  test('fabric_accessory is picked in the SOFA section', () => {
    for (const g of ['fabric_accessory', 'FABRIC_ACCESSORY', 'fabric accessory', 'sofa_accessory']) expect(packCategory(g)).toBe('SOFA');
    expect(packCategory('accessory')).toBe('ACCESSORIES');
  });

  test("a sofa order's square pillow is listed under that order's SO with its sofa", () => {
    const sections = buildPickSections([
      stop(2, [item('XAM-1S', 'sofa', 1), item('SQUARE PILLOW', 'fabric_accessory', 3)], { so_doc_no: 'SO-2' }),
      stop(1, [item('PIL-STD', 'accessory', 2)], { so_doc_no: 'SO-1' }),
    ], variantFromD2);
    expect(sections.map((s) => s.category)).toEqual(['ACCESSORIES', 'SOFA']);
    const sofa = sections.find((s) => s.category === 'SOFA')!;
    expect(sofa.groups.map((g) => g.so_doc_no)).toEqual(['SO-2']);
    expect(sofa.groups[0].rows.map((r) => r.item_code).sort()).toEqual(['SQUARE PILLOW', 'XAM-1S']);
  });
});

describe('packCategory', () => {
  test('maps item_group case-insensitively; anything else is OTHER', () => {
    expect(packCategory('MATTRESS')).toBe('MATTRESS');
    expect(packCategory('mattress')).toBe('MATTRESS');
    expect(packCategory('Bedframe')).toBe('BEDFRAME');
    expect(packCategory('accessory')).toBe('ACCESSORIES');
    expect(packCategory('Accessories')).toBe('ACCESSORIES');
    expect(packCategory('sofa')).toBe('SOFA');
    expect(packCategory('pillow-ish')).toBe('OTHER');
    expect(packCategory(null)).toBe('OTHER');
    expect(packCategory('')).toBe('OTHER');
  });

  test('the owner\'s order: MATTRESS, BEDFRAME, ACCESSORIES, SOFA, OTHER', () => {
    expect(PACK_CATEGORY_ORDER).toEqual(['MATTRESS', 'BEDFRAME', 'ACCESSORIES', 'SOFA', 'OTHER']);
  });
});

describe('comparePickRows — the one sort', () => {
  const row = (item_code: string, variant: string, customer: number, rack: string): PickRow => ({
    item_code, description: null, variant, pos: [], racks: [rack], qty: 1, customers: [customer], worked_out: false,
  });

  test('item code, then variant, then customer highest first, then rack', () => {
    const rows = [
      row('B', 'x', 1, 'Rack 1'),
      row('A', 'z', 1, 'Rack 1'),
      row('A', 'y', 2, 'Rack 9'),
      row('A', 'y', 5, 'Rack 3'),
      row('A', 'y', 5, 'Rack 2'),
    ];
    expect(sortPickRows(rows).map((r) => `${r.item_code}/${r.variant}/${r.customers[0]}/${r.racks[0]}`)).toEqual([
      'A/y/5/Rack 2', 'A/y/5/Rack 3', 'A/y/2/Rack 9', 'A/z/1/Rack 1', 'B/x/1/Rack 1',
    ]);
  });

  test('is deterministic: any input order gives the same output', () => {
    const rows = [row('C', '', 3, 'Rack 4'), row('A', '', 1, 'Rack 2'), row('B', 'q', 2, 'Rack 1'), row('A', '', 4, 'Rack 1')];
    const a = sortPickRows(rows);
    const b = sortPickRows([...rows].reverse());
    expect(a).toEqual(b);
    expect(rows[0].item_code).toBe('C');
  });

  test('item codes compare naturally (BF-9 before BF-10)', () => {
    expect(comparePickRows(row('BF-9', '', 1, ''), row('BF-10', '', 1, ''))).toBeLessThan(0);
  });
});

describe('buildPickSections', () => {
  const stops = [
    stop(1, [
      item('MAT-Q', 'mattress', 1, { rack: 'Rack 3', po: 'PO-4' }),
      item('PIL', 'accessories', 2, { rack: 'Rack 12', po: 'PO-88' }),
      item('BF-Q', 'bedframe', 1, { rack: 'Rack 7', po: 'PO-11', description2: 'Queen / Oak' }),
    ]),
    stop(3, [
      item('XAM-1S', 'sofa', 1, { rack: 'Rack 15', po: 'PO-21' }),
      item('XAM-ARM', 'sofa', 1, { rack: 'Rack 16', po: 'PO-22' }),
      item('BF-Q', 'bedframe', 1, { rack: 'Rack 9', po: 'PO-19', description2: 'Queen / Oak' }),
      item('MAT-Q', 'MATTRESS', 2, { rack: 'Rack 4', po: 'PO-6' }),
    ]),
    stop(6, [
      item('ZNT-L', 'Sofa', 1, { rack: 'Rack 18', po: 'PO-30' }),
      item('PIL', 'Accessory', 4, { rack: 'Rack 12', po: 'PO-88' }),
      item('MAT-Q', 'mattress', 1, { rack: 'Rack 3', po: 'PO-4', description2: 'Firm' }),
      item('WIDGET', null, 1),
    ]),
  ];
  const sections = buildPickSections(stops, variantFromD2);
  const of = (cat: string) => sections.find((s) => s.category === cat)!;

  test('sections come out in the owner\'s order, empty ones dropped', () => {
    expect(sections.map((s) => s.category)).toEqual(['MATTRESS', 'BEDFRAME', 'ACCESSORIES', 'SOFA', 'OTHER']);
    expect(buildPickSections([stop(1, [item('S', 'sofa', 1)])], variantFromD2).map((s) => s.category)).toEqual(['SOFA']);
  });

  test('MATTRESS aggregates same code + variant: total qty, all racks, all POs, customers descending', () => {
    const rows = of('MATTRESS').rows;
    expect(rows).toHaveLength(2);
    const plain = rows.find((r) => r.variant === '')!;
    expect(plain).toMatchObject({ item_code: 'MAT-Q', qty: 3, customers: [3, 1] });
    expect(plain.racks.sort()).toEqual(['Rack 3', 'Rack 4']);
    expect(plain.pos.sort()).toEqual(['PO-4', 'PO-6']);
    expect(of('MATTRESS').units).toBe(4);
  });

  test('ACCESSORIES aggregates across customers into one row', () => {
    expect(of('ACCESSORIES').rows).toEqual([
      expect.objectContaining({ item_code: 'PIL', qty: 6, customers: [6, 1], racks: ['Rack 12'], pos: ['PO-88'] }),
    ]);
  });

  test('BEDFRAME prints one row per line — same code, same variant, never merged', () => {
    const rows = of('BEDFRAME').rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.customers[0], r.racks[0], r.pos[0]])).toEqual([[3, 'Rack 9', 'PO-19'], [1, 'Rack 7', 'PO-11']]);
    expect(rows.every((r) => r.variant === 'Queen / Oak')).toBe(true);
  });

  test('SOFA is grouped by sales order, groups highest customer first, pieces kept apart', () => {
    const groups = of('SOFA').groups;
    expect(of('SOFA').rows).toEqual([]);
    expect(groups.map((g) => [g.so_doc_no, g.stop_no, g.pieces])).toEqual([['SO-6', 6, 1], ['SO-3', 3, 2]]);
    expect(groups[1].rows.map((r) => r.item_code)).toEqual(['XAM-1S', 'XAM-ARM']);
    expect(groups[1].pos).toEqual(['PO-21', 'PO-22']);
  });

  test('anything without a known group is OTHER, not dropped', () => {
    expect(of('OTHER').rows.map((r) => r.item_code)).toEqual(['WIDGET']);
  });

  test('a line with no PO or rack carries none (the sheet prints a dash, never a guess)', () => {
    const w = of('OTHER').rows[0];
    expect(w.pos).toEqual([]);
    expect(w.racks).toEqual([]);
  });

  test('a stop whose DO cannot be read, and a DO repeated on a second stop, add nothing', () => {
    const more = [
      ...stops,
      stop(7, [item('GHOST', 'mattress', 9)], { do_missing: true }),
      { ...stops[0], stop_no: 8 },
    ];
    const again = buildPickSections(more, variantFromD2);
    expect(again.reduce((n, s) => n + s.units, 0)).toBe(sections.reduce((n, s) => n + s.units, 0));
  });

  test('the same input in any stop order yields the same sheet', () => {
    expect(buildPickSections([...stops].reverse(), variantFromD2)).toEqual(sections);
  });
});

describe('shiftIsoDate', () => {
  test('crosses month and year ends in calendar days', async () => {
    const { shiftIsoDate } = await import('./packing-list-model');
    expect(shiftIsoDate('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIsoDate('2028-02-28', 1)).toBe('2028-02-29');
  });
});
