// Unit tests for planSoLineRelink — the PURE half of "a delete-and-reinsert of
// SO lines must not silently null every downstream so_item_id". Plan/apply are
// separated (the oversell-retrocost.ts precedent) precisely so the decision can
// be pinned here with no database in sight.
import { describe, expect, test } from 'vitest';
import {
  planSoLineRelink,
  applySoLineRelink,
  type SoLineIdentity,
  type SoLinkRow,
} from './so-line-relink';

const oldL = (id: string, itemCode: string, lineNo?: number): SoLineIdentity => ({ id, itemCode, lineNo });
const poLink = (rowId: string, soItemId: string): SoLinkRow =>
  ({ table: 'purchase_order_items', rowId, soItemId });

describe('planSoLineRelink', () => {
  test('a TBC fabric confirm keeps the same module SKUs, so every link follows', () => {
    // The routine case: the operator confirms the fabric, the build is split
    // into the SAME three module SKUs, only the variants changed.
    const oldLines = [oldL('O1', 'BOOQIT-1B(LHF)', 1), oldL('O2', 'BOOQIT-CNR', 2), oldL('O3', 'BOOQIT-2A(RHF)', 3)];
    const newLines = [oldL('N1', 'BOOQIT-1B(LHF)', 1), oldL('N2', 'BOOQIT-CNR', 2), oldL('N3', 'BOOQIT-2A(RHF)', 3)];
    const plan = planSoLineRelink(oldLines, newLines, [poLink('P1', 'O1'), poLink('P2', 'O2'), poLink('P3', 'O3')]);
    expect(plan.dropped).toEqual([]);
    expect(plan.restore).toEqual([
      { table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' },
      { table: 'purchase_order_items', rowId: 'P2', soItemId: 'N2' },
      { table: 'purchase_order_items', rowId: 'P3', soItemId: 'N3' },
    ]);
  });

  test('all three FK tables are carried, not just the PO', () => {
    const plan = planSoLineRelink([oldL('O1', 'X')], [oldL('N1', 'X')], [
      { table: 'purchase_order_items', rowId: 'P1', soItemId: 'O1' },
      { table: 'delivery_order_items', rowId: 'D1', soItemId: 'O1' },
      { table: 'sales_invoice_items', rowId: 'S1', soItemId: 'O1' },
    ]);
    expect(plan.restore.map((r) => r.table).sort()).toEqual(
      ['delivery_order_items', 'purchase_order_items', 'sales_invoice_items'],
    );
    expect(plan.restore.every((r) => r.soItemId === 'N1')).toBe(true);
  });

  test('a SKU with no counterpart in the new build is DROPPED, never re-pointed', () => {
    // Genuine model change: the 2-seater is gone. Re-pointing its PO line at the
    // 3-seater would make the link lie about what the supplier is building.
    const plan = planSoLineRelink(
      [oldL('O1', 'SEAT-2', 1), oldL('O2', 'CNR', 2)],
      [oldL('N1', 'SEAT-3', 1), oldL('N2', 'CNR', 2)],
      [poLink('P1', 'O1'), poLink('P2', 'O2')],
    );
    expect(plan.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P2', soItemId: 'N2' }]);
    expect(plan.dropped).toEqual([
      { table: 'purchase_order_items', rowId: 'P1', oldSoItemId: 'O1', itemCode: 'SEAT-2' },
    ]);
  });

  test('duplicate SKUs pair ordinally by line_no, not at random', () => {
    const plan = planSoLineRelink(
      [oldL('O-b', 'CNR', 2), oldL('O-a', 'CNR', 1)],
      [oldL('N-b', 'CNR', 8), oldL('N-a', 'CNR', 7)],
      [poLink('P1', 'O-a'), poLink('P2', 'O-b')],
    );
    expect(plan.restore).toEqual([
      { table: 'purchase_order_items', rowId: 'P1', soItemId: 'N-a' },
      { table: 'purchase_order_items', rowId: 'P2', soItemId: 'N-b' },
    ]);
  });

  test('un-numbered lines still pair deterministically (id order), never throw', () => {
    const a = planSoLineRelink([oldL('O2', 'C'), oldL('O1', 'C')], [oldL('N2', 'C'), oldL('N1', 'C')], [poLink('P', 'O1')]);
    const b = planSoLineRelink([oldL('O1', 'C'), oldL('O2', 'C')], [oldL('N1', 'C'), oldL('N2', 'C')], [poLink('P', 'O1')]);
    expect(a.restore).toEqual(b.restore);
    expect(a.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P', soItemId: 'N1' }]);
  });

  test('a shrinking build drops the surplus links instead of over-pairing', () => {
    const plan = planSoLineRelink(
      [oldL('O1', 'CNR', 1), oldL('O2', 'CNR', 2)],
      [oldL('N1', 'CNR', 1)],
      [poLink('P1', 'O1'), poLink('P2', 'O2')],
    );
    expect(plan.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' }]);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0].rowId).toBe('P2');
  });

  test('a growing build leaves the extra new lines unlinked (no invented links)', () => {
    const plan = planSoLineRelink(
      [oldL('O1', 'CNR', 1)],
      [oldL('N1', 'CNR', 1), oldL('N2', 'CNR', 2)],
      [poLink('P1', 'O1')],
    );
    expect(plan.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' }]);
    expect(plan.dropped).toEqual([]);
  });

  test('SKU comparison ignores case and surrounding blanks', () => {
    const plan = planSoLineRelink([oldL('O1', ' booqit-cnr ')], [oldL('N1', 'BOOQIT-CNR')], [poLink('P1', 'O1')]);
    expect(plan.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' }]);
  });

  test('no captured links is a clean no-op, not an error', () => {
    expect(planSoLineRelink([oldL('O1', 'C')], [oldL('N1', 'C')], [])).toEqual({ restore: [], dropped: [] });
  });

  test('a link pointing at a line outside the replaced build is reported, never guessed at', () => {
    const plan = planSoLineRelink([oldL('O1', 'C')], [oldL('N1', 'C')], [poLink('P9', 'ELSEWHERE')]);
    expect(plan.restore).toEqual([]);
    expect(plan.dropped).toEqual([
      { table: 'purchase_order_items', rowId: 'P9', oldSoItemId: 'ELSEWHERE', itemCode: null },
    ]);
  });

  test('blank rowId / soItemId entries are skipped rather than written as nulls', () => {
    const plan = planSoLineRelink([oldL('O1', 'C')], [oldL('N1', 'C')], [
      poLink('', 'O1'),
      poLink('P1', ''),
      poLink('P2', 'O1'),
    ]);
    expect(plan.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P2', soItemId: 'N1' }]);
    expect(plan.dropped).toEqual([]);
  });
});

describe('applySoLineRelink', () => {
  test('writes one update per restore and reports the counts', async () => {
    const writes: Array<{ table: string; id: string; soItemId: string }> = [];
    const sb = {
      from: (table: string) => ({
        update: (patch: { so_item_id: string }) => ({
          eq: (_col: string, id: string) => {
            writes.push({ table, id, soItemId: patch.so_item_id });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    const res = await applySoLineRelink(sb, {
      restore: [
        { table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' },
        { table: 'delivery_order_items', rowId: 'D1', soItemId: 'N1' },
      ],
      dropped: [{ table: 'purchase_order_items', rowId: 'P9', oldSoItemId: 'O9', itemCode: 'X' }],
    }, () => {});
    expect(writes).toEqual([
      { table: 'purchase_order_items', id: 'P1', soItemId: 'N1' },
      { table: 'delivery_order_items', id: 'D1', soItemId: 'N1' },
    ]);
    expect(res).toEqual({ restored: 2, dropped: 1 });
  });

  test('a write error reaches the caller-supplied handler, so the command can roll back', async () => {
    const seen: string[] = [];
    const sb = {
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    };
    await expect(applySoLineRelink(sb, {
      restore: [{ table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' }],
      dropped: [],
    }, (err, label) => {
      seen.push(label);
      if (err) throw new Error(`${label}: ${err.message}`);
    })).rejects.toThrow(/boom/);
    expect(seen).toHaveLength(1);
  });
});
