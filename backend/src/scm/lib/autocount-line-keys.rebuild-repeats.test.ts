import { describe, expect, it } from 'vitest';
import { newLineTargetOf, persistNewLineKeys } from './autocount-line-keys';
import { fakeSb } from './fake-postgrest';

/* HC-SO-2609-071 as the book and the ERP held it on 2026-09-14: six lines, A01
   on the first and the fifth, no Desc2 on either. Created keyless (0890), and a
   rebuild is the only road that can key it — which this refusal closed.
   docs/bugs/0907. */
const codes = ['A01', 'SB02', 'BC05-MF', '8211-7FT', 'A01', 'HOK-SQUARE PILLOW'];
const rows = () => codes.map((c, i) => ({ id: `row-${i + 1}`, doc_no: 'HC-SO-2609-071', item_code: c, linked_ac_dtlkey: null }));
const lines = (extra: Record<string, unknown>) => codes.map((c, i) => ({ ItemCode: c, ErpLineIds: [`row-${i + 1}`], ...extra }));
const book = codes.map((c, i) => ({ Seq: (i + 1) * 16, DtlKey: 930681 + i, ItemCode: c }));
const label = { op: 'edit', doc_no: 'HC-SO-2609-071' } as never;

describe('a rebuild whose document repeats an item code with no Desc2', () => {
  it('stores every reissued key by position', async () => {
    const sb = fakeSb({ mfg_sales_order_items: rows() });
    const target = newLineTargetOf('SO', { body: { Rebuild: true, Lines: lines({ DtlKey: 1 }) } });
    await persistNewLineKeys(sb as never, label, target!, book as never);
    const { data } = await sb.from('mfg_sales_order_items').select('id, linked_ac_dtlkey');
    const keyOf = new Map((data as Array<{ id: string; linked_ac_dtlkey: number }>).map((r) => [r.id, r.linked_ac_dtlkey]));
    expect(codes.map((_, i) => keyOf.get(`row-${i + 1}`))).toEqual(book.map((b) => b.DtlKey));
    expect(target?.rebuilt).toBe(true);
  });

  it('CONTROL: an ordinary edit adding the same code twice with no Desc2 still stores nothing', async () => {
    const sb = fakeSb({ mfg_sales_order_items: rows() });
    const target = newLineTargetOf('SO', { body: { Lines: lines({ IsNewLine: true }) } });
    await persistNewLineKeys(sb as never, label, target!, book as never);
    const { data } = await sb.from('mfg_sales_order_items').select('id, linked_ac_dtlkey');
    expect((data as Array<{ linked_ac_dtlkey: number | null }>).every((r) => r.linked_ac_dtlkey == null)).toBe(true);
  });

  it('CONTROL: a rebuild still stores nothing when a position disagrees on the item code', async () => {
    const sb = fakeSb({ mfg_sales_order_items: rows() });
    const target = newLineTargetOf('SO', { body: { Rebuild: true, Lines: lines({ DtlKey: 1 }) } });
    const swapped = book.map((b, i) => (i === 1 ? { ...b, ItemCode: 'BC05-MF' } : i === 2 ? { ...b, ItemCode: 'SB02' } : b));
    await persistNewLineKeys(sb as never, label, target!, swapped as never);
    const { data } = await sb.from('mfg_sales_order_items').select('id, linked_ac_dtlkey');
    expect((data as Array<{ linked_ac_dtlkey: number | null }>).every((r) => r.linked_ac_dtlkey == null)).toBe(true);
  });
});
