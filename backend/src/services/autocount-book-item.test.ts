// autocount-book-item — the book's Item Description, Item Group and UOM for a
// line, from the generated live-book snapshot (autocount-item-master.ts).
import { describe, expect, it } from 'vitest';
import { AC_ITEM_MASTER_ROWS, AC_ITEM_MASTER_TSV } from './autocount-item-master';
import { acBookItemIndex, bookLineItem } from './autocount-book-item';
import { AC_ITEM_MAP_TSV } from './autocount-item-map';
import { resolveAcItemCode } from './autocount-item-code';

describe('the item master snapshot', () => {
  it('parses: every record has four fields, a code, a group and a UOM, and no code repeats', () => {
    const lines = AC_ITEM_MASTER_TSV.split('\n');
    expect(lines).toHaveLength(AC_ITEM_MASTER_ROWS);
    const codes = new Set<string>();
    for (const l of lines) {
      const f = l.split('\t');
      expect(f, l).toHaveLength(4);
      expect(f[0]!.trim(), l).not.toBe('');
      expect(f[2]!.trim(), l).not.toBe('');
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
  it('prints the book code, description, group and UOM for an item the resolver maps', () => {
    const [ac, erp] = AC_ITEM_MAP_TSV.split('\n').find((l) => l.startsWith('AERO-Y04 (K)\t'))!.split('\t');
    const book = acBookItemIndex().get(ac!.toUpperCase())!;
    expect(bookLineItem({ itemCode: erp, description: 'our words', category: 'bedframe', uom: 'unit' }, '400-A001')).toEqual({
      itemCode: ac, resolved: true, inBook: true,
      description: book.description, itemGroup: book.itemGroup, uom: book.baseUom,
    });
  });

  it('falls back to the ERP values, category and UOM in capitals, when the book has no such item', () => {
    /* The item code is whatever the write-back's resolver answers — for a code the
       book never held that is the ERP code itself (its erp-canonical rule). */
    const r = resolveAcItemCode('NOT-A-REAL-CODE-XYZ', {});
    expect(bookLineItem({ itemCode: 'NOT-A-REAL-CODE-XYZ', description: ' Our words ', category: 'accessory', uom: 'unit' }, null)).toEqual({
      itemCode: r.ok ? r.acItemCode : 'NOT-A-REAL-CODE-XYZ', resolved: r.ok, inBook: false,
      description: 'Our words', itemGroup: 'ACCESSORY', uom: 'UNIT',
    });
    expect(bookLineItem({ itemCode: null, description: null, category: null, uom: null }, null))
      .toEqual({ itemCode: null, resolved: false, inBook: false, description: null, itemGroup: null, uom: null });
  });

  it('forwards the write-back binding: where the map is ambiguous, a binding naming a book item decides the code', () => {
    /* 9028-1S has several book items in the cutover map; with no supplier the
       resolver answers the ERP code (autocount-item-code.test.ts). A binding to
       one of those items is the tie-breaker the write-back uses. */
    const erp = { itemCode: '9028-1S', description: null, category: 'sofa', uom: 'unit' };
    const without = bookLineItem(erp, null);
    const bound = bookLineItem(erp, null, { bindings: new Map([['9028-1S', 'AMN-SF9028 SOFA']]) });
    expect(bound.itemCode).toBe('AMN-SF9028 SOFA');
    expect(bound.itemCode).not.toBe(without.itemCode);
    expect(bound.inBook).toBe(true);
    expect(bookLineItem(erp, null, { bindings: null })).toEqual(without);
  });
});
