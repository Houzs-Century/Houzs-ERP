/* 2990-0065: 2990-SO-2608-042's sofa lines went on 2990-PO-2611-036 and again on
   2990-PO-2611-044. A line already on a live PO must be named before another
   PO is generated for it. */
import { describe, expect, test } from 'vitest';
import { soLinesOnLivePo, soHasPoRefusal } from './so-line-po-duplicate';

type Row = Record<string, unknown>;

function fakeSb(rows: Row[], error: { message: string } | null = null) {
  const calls: string[] = [];
  class Q {
    rows: Row[];
    constructor(t: string) { calls.push(t); this.rows = [...rows]; }
    select() { return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    order() { return this; }
    range(from: number, to: number) { this.rows = this.rows.slice(from, to + 1); return this; }
    then<T>(onF: (v: { data: Row[] | null; error: { message: string } | null }) => T) {
      return Promise.resolve({ data: error ? null : this.rows, error }).then(onF);
    }
  }
  return { from: (t: string) => new Q(t), calls };
}

const line = (soItemId: string, poNumber: string, status: string): Row => ({ so_item_id: soItemId, po: { po_number: poNumber, status } });
const so = [
  { id: 'a', doc_no: '2990-SO-2608-042', item_code: 'XAMMAR-1A(LHF)' },
  { id: 'b', doc_no: '2990-SO-2608-042', item_code: 'XAMMAR-2A(RHF)' },
];

describe('soLinesOnLivePo', () => {
  test('names the live PO for each picked line; a cancelled PO does not count', async () => {
    const sb = fakeSb([line('a', '2990-PO-2611-036', 'SUBMITTED'), line('b', '2990-PO-2611-036', 'SUBMITTED'), line('a', '2990-PO-2611-044', 'CANCELLED')]);
    const hits = await soLinesOnLivePo(sb, so);
    expect(hits).toEqual([
      { soItemId: 'a', soDocNo: '2990-SO-2608-042', itemCode: 'XAMMAR-1A(LHF)', poNumber: '2990-PO-2611-036' },
      { soItemId: 'b', soDocNo: '2990-SO-2608-042', itemCode: 'XAMMAR-2A(RHF)', poNumber: '2990-PO-2611-036' },
    ]);
  });

  test('a DRAFT PO counts — it is a PO already generated', async () => {
    const hits = await soLinesOnLivePo(fakeSb([line('a', '2990-PO-2611-050', 'DRAFT')]), so);
    expect(hits.map((h) => h.poNumber)).toEqual(['2990-PO-2611-050']);
  });

  test('per line: another line of the same SO on a PO does not flag this one', async () => {
    const hits = await soLinesOnLivePo(fakeSb([line('b', '2990-PO-2611-036', 'SUBMITTED')]), [so[0]!]);
    expect(hits).toEqual([]);
  });

  test('no SO link reads nothing', async () => {
    const sb = fakeSb([]);
    expect(await soLinesOnLivePo(sb, [{ id: '', doc_no: 'X', item_code: 'Y' }])).toEqual([]);
    expect(sb.calls).toHaveLength(0);
  });

  test('a failed read throws instead of answering "no PO"', async () => {
    await expect(soLinesOnLivePo(fakeSb([], { message: 'boom' }), so)).rejects.toThrow(/so_line_po_read_failed/);
  });
});

describe('soHasPoRefusal', () => {
  test('null when nothing is on a PO', () => {
    expect(soHasPoRefusal([])).toBeNull();
  });

  test('409 body lists each PO once', () => {
    const body = soHasPoRefusal([
      { soItemId: 'a', soDocNo: 'S', itemCode: 'A', poNumber: '2990-PO-2611-036' },
      { soItemId: 'b', soDocNo: 'S', itemCode: 'B', poNumber: '2990-PO-2611-036' },
    ]);
    expect(body).toMatchObject({ error: 'so_has_po', poNumbers: ['2990-PO-2611-036'] });
    expect(body?.reason).toBe('This Sales Order already has PO(s): 2990-PO-2611-036.');
  });
});
