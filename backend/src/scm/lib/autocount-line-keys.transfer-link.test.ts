import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fakeSb } from './fake-postgrest';
import { persistLineKeys, type LineKeyTarget } from './autocount-line-keys';
import { parseCreatedLines } from '../../services/autocount-created-lines';

/* docs/bugs/0898. A conversion's created lines now carry the source line
 * AutoCount's DocTransfer names, and the drain pairs our rows by THAT link.
 * The case that motivated it is HC-DO-2609-096 as the book holds it: one sofa
 * line (930287, from SO line 758395) and a pillow (930289, from 758396), while
 * the ERP holds the sofa as two pieces and spells the codes its own way — the
 * count and the codes both disagree, and the pairing is still exact. */

const target = (over: Partial<LineKeyTarget> = {}): LineKeyTarget => ({
  table: 'delivery_order_items' as LineKeyTarget['table'],
  ids: ['piece-1', 'piece-2', 'pillow'],
  codes: ['DSL-8030-2A(LHF)', 'DSL-8030-1A(RHF)', 'AKEMI SOFA PILLOW'],
  ...over,
});

const doSeed = () => fakeSb({
  delivery_order_items: [
    { id: 'piece-1', so_item_id: 'so-sofa-a', linked_ac_dtlkey: null },
    { id: 'piece-2', so_item_id: 'so-sofa-b', linked_ac_dtlkey: null },
    { id: 'pillow', so_item_id: 'so-pillow', linked_ac_dtlkey: null },
  ],
  mfg_sales_order_items: [
    { id: 'so-sofa-a', linked_ac_dtlkey: 758395 },
    { id: 'so-sofa-b', linked_ac_dtlkey: 758395 },
    { id: 'so-pillow', linked_ac_dtlkey: 758396 },
  ],
});

const keyOf = (sb: { tables: Record<string, Array<Record<string, unknown>>> }, table: string, id: string) =>
  sb.tables[table].find((r) => r.id === id)?.linked_ac_dtlkey ?? null;

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('a conversion the book linked is paired by the link', () => {
  test('sofa pieces and a pillow take their lines, although the count and the codes differ', async () => {
    const sb = doSeed();
    const reason = await persistLineKeys(sb, { op: 'so_to_do', doc_no: 'HC-DO-2609-096' }, target(), [
      { Seq: 0, DtlKey: 930287, ItemCode: 'DSL-8030 SOFA', FromDocDtlKey: 758395 },
      { Seq: 1, DtlKey: 930289, ItemCode: 'AMN-SOFA PILLOW', FromDocDtlKey: 758396 },
    ]);
    expect(reason).toBeNull();
    expect(keyOf(sb, 'delivery_order_items', 'piece-1')).toBe(930287);
    expect(keyOf(sb, 'delivery_order_items', 'piece-2')).toBe(930287);
    expect(keyOf(sb, 'delivery_order_items', 'pillow')).toBe(930289);
  });

  test('a line added on the receipt has no source: the rest are stored and the gap is named', async () => {
    const sb = fakeSb({
      grn_items: [
        { id: 'mattress', purchase_order_item_id: 'po-1', linked_ac_dtlkey: null },
        { id: 'free-pillow', purchase_order_item_id: null, linked_ac_dtlkey: null },
      ],
      purchase_order_items: [{ id: 'po-1', linked_ac_dtlkey: 907001 }],
    });
    const reason = await persistLineKeys(sb, { op: 'po_to_gr', doc_no: 'HC-GRN-2609-015' }, target({
      table: 'grn_items' as LineKeyTarget['table'], ids: ['mattress', 'free-pillow'], codes: ['AKEMI ARMOUR MATT (K)', 'AK-SLEEP ESSENTIAL 7 HOLES'],
    }), [
      { Seq: 0, DtlKey: 940001, ItemCode: 'AK-ARMOUR MATT (K)', FromDocDtlKey: 907001 },
    ]);
    expect(keyOf(sb, 'grn_items', 'mattress')).toBe(940001);
    expect(keyOf(sb, 'grn_items', 'free-pillow')).toBeNull();
    expect(reason).toContain('1 of 2 row(s)');
    expect(reason).toContain('no_source_key');
  });

  test('one source feeding two book lines is refused, not guessed', async () => {
    const sb = doSeed();
    const reason = await persistLineKeys(sb, { op: 'so_to_do', doc_no: 'HC-DO-X' }, target({ ids: ['pillow'], codes: ['AKEMI SOFA PILLOW'] }), [
      { Seq: 0, DtlKey: 930289, ItemCode: 'AMN-SOFA PILLOW', FromDocDtlKey: 758396 },
      { Seq: 1, DtlKey: 930290, ItemCode: 'AMN-SOFA PILLOW', FromDocDtlKey: 758396 },
    ]);
    expect(keyOf(sb, 'delivery_order_items', 'pillow')).toBeNull();
    expect(reason).toContain('ambiguous_in_book');
  });

  /* A host built before the link was added reports no FromDocDtlKey, and one
     unlinked line is enough: the old checks decide, exactly as before. */
  test('without the link on every line, the count and code checks still run', async () => {
    const sb = doSeed();
    const reason = await persistLineKeys(sb, { op: 'so_to_do', doc_no: 'HC-DO-2609-096' }, target(), [
      { Seq: 0, DtlKey: 930287, ItemCode: 'DSL-8030 SOFA', FromDocDtlKey: 758395 },
      { Seq: 1, DtlKey: 930289, ItemCode: 'AMN-SOFA PILLOW' },
    ]);
    expect(reason).toContain('AutoCount reported 2 line(s) and the ERP sent 3');
    expect(keyOf(sb, 'delivery_order_items', 'piece-1')).toBeNull();
  });

  test('a create never takes the link path', async () => {
    const sb = fakeSb({ mfg_sales_order_items: [{ id: 'a', linked_ac_dtlkey: null }] });
    const reason = await persistLineKeys(sb, { op: 'create_so', doc_no: 'HC-SO-X' }, target({
      table: 'mfg_sales_order_items' as LineKeyTarget['table'], ids: ['a'], codes: ['A01'],
    }), [{ Seq: 0, DtlKey: 1, ItemCode: 'A01', FromDocDtlKey: 99 }]);
    expect(reason).toBeNull();
    expect(keyOf(sb, 'mfg_sales_order_items', 'a')).toBe(1);
  });
});

describe('parseCreatedLines reads the link and nothing it cannot trust', () => {
  test('a positive integer is kept; null, zero and text leave it off the line', () => {
    const lines = parseCreatedLines([
      { Seq: 0, DtlKey: 10, ItemCode: 'A', FromDocDtlKey: 758395 },
      { Seq: 1, DtlKey: 11, ItemCode: 'B', FromDocDtlKey: null },
      { Seq: 2, DtlKey: 12, ItemCode: 'C', FromDocDtlKey: 0 },
      { Seq: 3, DtlKey: 13, ItemCode: 'D', FromDocDtlKey: 'x' },
    ]);
    expect(lines.map((l) => l.FromDocDtlKey)).toEqual([758395, undefined, undefined, undefined]);
    expect(lines.every((l, i) => !('FromDocDtlKey' in l) || i === 0)).toBe(true);
  });
});
