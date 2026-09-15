// autocount-book-item — the book's Item Group and UOM for a line, from the
// generated live-book snapshot (autocount-item-master.ts).
import { describe, expect, it } from 'vitest';
import { AC_ITEM_MASTER_ROWS, AC_ITEM_MASTER_TSV } from './autocount-item-master';
import { acBookItemIndex, bookLineItem } from './autocount-book-item';
import { AC_ITEM_MAP_TSV } from './autocount-item-map';
import { resolveAcItemCode } from './autocount-item-code';

describe('the item master snapshot', () => {
  it('parses: every record has four fields, a code and a group, and no code repeats', () => {
    const lines = AC_ITEM_MASTER_TSV.split('\n');
    expect(lines).toHaveLength(AC_ITEM_MASTER_ROWS);
    const codes = new Set<string>();
    for (const l of lines) {
      const f = l.split('\t');
      expect(f, l).toHaveLength(4);
      expect(f[0]!.trim(), l).not.toBe('');
      expect(f[1]!.trim(), l).not.toBe('');
      codes.add(f[0]!.trim().toUpperCase());
    }
    expect(codes.size).toBe(AC_ITEM_MASTER_ROWS);
    expect(acBookItemIndex().size).toBe(AC_ITEM_MASTER_ROWS);
  });

  it('knows every AutoCount item the cutover map names', () => {
    const missing = AC_ITEM_MAP_TSV.trim().split('\n').map((l) => l.split('\t')[0]!.trim().toUpperCase())
      .filter((c) => !acBookItemIndex().has(c));
    expect(missing).toEqual([]);
  });
});

describe('bookLineItem', () => {
  it('prints the book code, group and UOM for an item the resolver maps', () => {
    const first = AC_ITEM_MAP_TSV.split('\n').find((l) => l.startsWith('AERO-Y04 (K)\t'))!;
    const [ac, erp] = first.split('\t');
    const book = acBookItemIndex().get(ac!.toUpperCase())!;
    const r = bookLineItem(erp, 'bedframe', 'unit', '400-A001');
    expect(r).toEqual({ itemCode: ac, resolved: true, itemGroup: book.itemGroup, uom: book.salesUom });
  });

  it('spells our category and UOM in capitals when the book has no such item', () => {
    /* The item code is whatever the write-back's resolver answers — for a code the
       book never held that is the ERP code itself (its erp-canonical rule). */
    const r = resolveAcItemCode('NOT-A-REAL-CODE-XYZ', {});
    expect(bookLineItem('NOT-A-REAL-CODE-XYZ', 'accessory', 'unit', null))
      .toEqual({ itemCode: r.ok ? r.acItemCode : 'NOT-A-REAL-CODE-XYZ', resolved: r.ok, itemGroup: 'ACCESSORY', uom: 'UNIT' });
    expect(bookLineItem(null, null, null, null)).toEqual({ itemCode: null, resolved: false, itemGroup: null, uom: null });
  });
});
