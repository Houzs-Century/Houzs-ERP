// autocount-book-item — the book's Item Description, Item Group and UOM for a
// line, from the generated live-book snapshot (autocount-item-master.ts).
import { describe, expect, it } from 'vitest';
import { AC_ITEM_MASTER_ROWS, AC_ITEM_MASTER_TSV } from './autocount-item-master';
import { acBookItemIndex, bookLineItem } from './autocount-book-item';
import { AC_ITEM_MAP_TSV } from './autocount-item-map';
import { resolveAcItemCode } from './autocount-item-code';
import { splitSofaCode } from './autocount-sofa-collapse';

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

  it('a line bound to a supplier SKU the book does not hold keeps the bound code but reads the book item of its own code', () => {
    /* Not a sofa piece: the #3945 rule stands. */
    const [ac, erp] = AC_ITEM_MAP_TSV.split('\n').find((l) => l.startsWith('AERO-Y04 (K)\t'))!.split('\t');
    const book = acBookItemIndex().get(ac!.toUpperCase())!;
    const r = bookLineItem({ itemCode: erp, description: 'our words', category: 'bedframe', uom: 'unit' }, '400-A001', { bindings: new Map([[erp!.toUpperCase(), 'SUPPLIER SKU NOT IN THE BOOK']]) });
    expect(r).toMatchObject({ itemCode: 'SUPPLIER SKU NOT IN THE BOOK', inBook: true, itemGroup: book.itemGroup, uom: book.baseUom });
  });
});

describe('bookLineItem — a sofa piece is listed under the model set item, never an OTHER piece item', () => {
  const piece = (itemCode: string) => ({ itemCode, description: 'our words', category: 'sofa', uom: 'unit' });

  it('the fixtures: the bound piece codes are OTHER items in the master, and 9028-1S resolves to a SOFA set for 400-D004 only', () => {
    expect(acBookItemIndex().get('5530-1A(RHF)')?.itemGroup).toBe('OTHER');
    expect(acBookItemIndex().get('5530-2A(LHF)')?.itemGroup).toBe('OTHER');
    expect(acBookItemIndex().get('9028-1A(RHF)')?.itemGroup).toBe('OTHER');
    expect(resolveAcItemCode('9028-1S', { supplierCode: '400-D004' })).toMatchObject({ ok: true, acItemCode: 'DSL-9028 SOFA' });
    expect(resolveAcItemCode('9028-1S', { supplierCode: '400-O002' }).ok).toBe(false);
    expect(acBookItemIndex().get('DSL-9028 SOFA')).toMatchObject({ itemGroup: 'SOFA', baseUom: 'SET' });
  });

  it('a bound piece code that is OTHER in the master gets the set item: group SOFA, UOM SET, the set description; the Item Code stays the bound answer', () => {
    const set = acBookItemIndex().get('DSL-9028 SOFA')!;
    const r = bookLineItem(piece('9028-1A(RHF)'), '400-D004', { bindings: new Map([['9028-1A(RHF)', '5530-1A(RHF)']]) });
    expect(r).toEqual({ itemCode: '5530-1A(RHF)', resolved: true, inBook: true, description: set.description, itemGroup: 'SOFA', uom: 'SET' });
  });

  it('when the set item does not resolve, a bound OTHER piece falls back to our values: SOFA from the category, our UOM, our description', () => {
    const r = bookLineItem(piece('9028-2A(LHF)'), '400-O002', { bindings: new Map([['9028-2A(LHF)', '5530-2A(LHF)']]) });
    expect(r).toEqual({ itemCode: '5530-2A(LHF)', resolved: true, inBook: false, description: 'our words', itemGroup: 'SOFA', uom: 'UNIT' });
  });

  it('an unbound piece whose own code is an OTHER book item is not read either', () => {
    const r = bookLineItem(piece('9028-1A(RHF)'), null, { bindings: new Map([['9028-1A(RHF)', 'DSL-9028 SOFA 1A(RHF)']]) });
    expect(r.itemCode).toBe('DSL-9028 SOFA 1A(RHF)');
    expect(r.itemGroup).toBe('SOFA');
    expect(bookLineItem(piece('9028-1A(RHF)'), null).itemGroup).toBe('SOFA');
  });

  it('a line that is not a sofa piece still reads an OTHER book item', () => {
    const other = [...acBookItemIndex()].find(([code, item]) => item.itemGroup === 'OTHER'
      && resolveAcItemCode(code, {}).ok && (resolveAcItemCode(code, {}) as { acItemCode: string }).acItemCode.toUpperCase() === code
      && splitSofaCode(code) === null);
    expect(other, 'the fixture needs a non-piece OTHER item').toBeDefined();
    expect(bookLineItem({ itemCode: other![0], description: null, category: 'service', uom: 'unit' }, null).itemGroup).toBe('OTHER');
  });
});
