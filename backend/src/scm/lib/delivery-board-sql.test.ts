// The SQL board path's own folds, checked against the engines they stand in for
// (run through the fake PostgREST on the SAME rows), plus the shadow diff and the
// switch. The SQL text itself runs on real Postgres in
// tests-pg/deliveryBoardSql.pg.test.ts.
import { describe, expect, it } from 'vitest';

import { fakeSb, type Row } from './fake-postgrest';
import { boardDeliverableByDoc } from './board-deliverable';
import { planningPoNosByDoc } from './planning-po-nos';
import { chunkIn } from './paginate-all';
import { chunkRank, foldDeliverable, foldPoNos } from './delivery-board-sql';
import { diffBoardRows, parseBoardSource } from './delivery-board-source';

/* Two orders: A has a linked delivery, a partial return, a cancelled return, a
   DRAFT DO that must not count and an unlinked line under a delivered DO; B has
   an unlinked line bigger than its open qty (capped) and a cancelled DO. */
const items: Row[] = [
  { id: 'a1', doc_no: 'A', item_code: 'SOFA-1', item_group: 'SOFA', qty: 3, cancelled: false, line_no: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 'a2', doc_no: 'A', item_code: 'bed-1 ', item_group: 'BEDFRAME', qty: 2, cancelled: false, line_no: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 'a3', doc_no: 'A', item_code: 'SOFA-1', item_group: 'SOFA', qty: 9, cancelled: true, line_no: 3, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b1', doc_no: 'B', item_code: 'MAT-1', item_group: 'MATTRESS', qty: 1, cancelled: false, line_no: 1, created_at: '2026-01-01T00:00:00Z' },
];
const dos: Row[] = [
  { id: 'dA1', so_doc_no: 'A', status: 'DELIVERED' },
  { id: 'dA2', so_doc_no: 'A', status: 'DRAFT' },
  { id: 'dB1', so_doc_no: 'B', status: 'DELIVERED' },
  { id: 'dB2', so_doc_no: 'B', status: 'CANCELLED' },
];
const doItems: Row[] = [
  { id: 'l1', delivery_order_id: 'dA1', so_item_id: 'a1', item_code: 'SOFA-1', qty: 2 },
  { id: 'l2', delivery_order_id: 'dA2', so_item_id: 'a1', item_code: 'SOFA-1', qty: 1 },
  { id: 'l3', delivery_order_id: 'dA1', so_item_id: null, item_code: 'BED-1', qty: 1 },
  { id: 'l4', delivery_order_id: 'dB1', so_item_id: null, item_code: 'MAT-1', qty: 5 },
  { id: 'l5', delivery_order_id: 'dB2', so_item_id: null, item_code: 'MAT-1', qty: 1 },
];
const returns: Row[] = [
  { id: 'r1', do_item_id: 'l1', delivery_return_id: 'R1', qty_returned: 1 },
  { id: 'r2', do_item_id: 'l1', delivery_return_id: 'R2', qty_returned: 1 },
  { id: 'r3', do_item_id: 'l3', delivery_return_id: 'R1', qty_returned: 1 },
];
const drStatus: Record<string, string> = { R1: 'RECEIVED', R2: 'CANCELLED' };

describe('foldDeliverable = soDeliverableRemaining summed per order', () => {
  it('linked, DRAFT, unlinked (capped), returns, cancelled returns', async () => {
    const doStatus = new Map(dos.map((d) => [d.id, d.status]));
    // The PostgREST engine reads embedded parents; give the fake the embed.
    const sb = fakeSb({
      mfg_sales_order_items: items,
      mfg_sales_orders: [{ doc_no: 'A', debtor_code: null, debtor_name: null }, { doc_no: 'B', debtor_code: null, debtor_name: null }],
      delivery_orders: dos,
      delivery_order_items: doItems.map((l) => ({ ...l, parent: { status: doStatus.get(l.delivery_order_id) } })),
      delivery_return_items: returns.map((r) => ({ ...r, parent: { status: drStatus[r.delivery_return_id] } })),
    });
    const engine = await boardDeliverableByDoc(sb, ['A', 'B']);

    const live = items.filter((i) => !i.cancelled);
    const folded = foldDeliverable({
      items: live as never,
      dos: dos as never,
      linked: doItems.filter((l) => live.some((i) => i.id === l.so_item_id))
        .map((l) => ({ id: l.id, so_item_id: l.so_item_id, qty: l.qty, parent_status: doStatus.get(l.delivery_order_id) ?? null, has_parent: true })),
      unlinked: doItems.filter((l) => l.so_item_id == null),
      rets: returns.map((r) => ({ do_item_id: r.do_item_id, qty_returned: r.qty_returned, parent_status: drStatus[r.delivery_return_id] ?? null, has_parent: true })),
    });
    expect(Object.fromEntries(folded.deliveredByDoc)).toEqual(Object.fromEntries(engine.deliveredByDoc));
    expect(Object.fromEntries(folded.remainingByDoc)).toEqual(Object.fromEntries(engine.remainingByDoc));
    // And the numbers themselves: A delivered 2 linked + 1 unlinked bed, returned 1 + 1.
    expect(Object.fromEntries(folded.deliveredByDoc)).toEqual({ A: 3, B: 1 });
    expect(Object.fromEntries(folded.remainingByDoc)).toEqual({ A: 4, B: 0 });
  });

  it('an orphan DO line (no parent) and an orphan return count nothing', () => {
    const r = foldDeliverable({
      items: [{ id: 'x1', doc_no: 'X', item_code: 'S', qty: 2 }] as never,
      dos: [],
      linked: [{ id: 'o1', so_item_id: 'x1', qty: 2, parent_status: null, has_parent: false }],
      unlinked: [],
      rets: [{ do_item_id: 'o1', qty_returned: 1, parent_status: null, has_parent: false }],
    });
    expect(r.deliveredByDoc.get('X')).toBe(0);
    expect(r.remainingByDoc.get('X')).toBe(2);
  });
});

describe('foldPoNos = planningPoNosByDoc', () => {
  it('per company, CANCELLED dropped, numeric sort, de-duplicated', async () => {
    const sb = fakeSb({
      mfg_sales_order_items: [
        { id: 'i1', doc_no: 'A', company_id: 1 }, { id: 'i2', doc_no: 'A', company_id: 1 }, { id: 'i3', doc_no: 'B', company_id: 2 },
      ],
      purchase_order_items: [
        { so_item_id: 'i1', purchase_order_id: 'p10', company_id: 1 }, { so_item_id: 'i2', purchase_order_id: 'p9', company_id: 1 },
        { so_item_id: 'i2', purchase_order_id: 'p10', company_id: 1 }, { so_item_id: 'i1', purchase_order_id: 'px', company_id: 1 },
        { so_item_id: 'i3', purchase_order_id: 'p2', company_id: 2 },
      ],
      purchase_orders: [
        { id: 'p10', po_number: 'PO-10', status: 'ISSUED', company_id: 1 }, { id: 'p9', po_number: 'PO-9', status: 'DRAFT', company_id: 1 },
        { id: 'px', po_number: 'PO-1', status: 'CANCELLED', company_id: 1 }, { id: 'p2', po_number: 'PO-2', status: 'ISSUED', company_id: 2 },
      ],
    });
    const engine = await planningPoNosByDoc(sb, [{ doc_no: 'A', company_id: 1 }, { doc_no: 'B', company_id: 2 }]);
    const folded = foldPoNos([
      { cid: 1, doc_no: 'A', po_id: 'p10', po_number: 'PO-10', status: 'ISSUED' },
      { cid: 1, doc_no: 'A', po_id: 'p9', po_number: 'PO-9', status: 'DRAFT' },
      { cid: 1, doc_no: 'A', po_id: 'p10', po_number: 'PO-10', status: 'ISSUED' },
      { cid: 1, doc_no: 'A', po_id: 'px', po_number: 'PO-1', status: 'CANCELLED' },
      { cid: 2, doc_no: 'B', po_id: 'p2', po_number: 'PO-2', status: 'ISSUED' },
    ], [1, 2]);
    expect(Object.fromEntries(folded)).toEqual(Object.fromEntries(engine));
    expect(folded.get('A')).toEqual(['PO-9', 'PO-10']);
  });
});

describe('chunkRank = the batch chunkIn puts each value in', () => {
  it('matches chunkIn batching on a list wider than one batch', async () => {
    const values = Array.from({ length: 450 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const batches: string[][] = [];
    await chunkIn(values, (batch) => { batches.push(batch); return Promise.resolve({ data: [], error: null }); });
    const rank = chunkRank(values);
    expect(batches.length).toBeGreaterThan(1);
    batches.forEach((b, i) => { for (const v of b) expect(rank.get(v)).toBe(i); });
  });
});

describe('diffBoardRows', () => {
  it('names the differing fields per order, nested one level, ignoring key order', () => {
    const old = [
      { so_doc_no: 'A', status: 'X', crew: { driver: 'Ali', lorry: 'V1' }, po_nos: ['P1'] },
      { so_doc_no: 'B', status: 'X' },
      { so_doc_no: 'C', status: 'X' },
    ];
    const neu = [
      { po_nos: ['P1'], crew: { lorry: 'V2', driver: 'Ali' }, status: 'X', so_doc_no: 'A' },
      { so_doc_no: 'B', status: 'X' },
      { so_doc_no: 'D', status: 'X' },
    ];
    expect(diffBoardRows(old, neu)).toEqual([
      { doc_no: 'A', fields: ['crew.lorry'] },
      { doc_no: 'C', fields: ['(missing in sql)'] },
      { doc_no: 'D', fields: ['(extra in sql)'] },
    ]);
  });
});

describe('parseBoardSource', () => {
  it('only shadow and sql leave the old path', () => {
    expect(parseBoardSource(null)).toBe('rest');
    expect(parseBoardSource('')).toBe('rest');
    expect(parseBoardSource('REST')).toBe('rest');
    expect(parseBoardSource('sqll')).toBe('rest');
    expect(parseBoardSource(' Shadow ')).toBe('shadow');
    expect(parseBoardSource('sql')).toBe('sql');
  });
});
