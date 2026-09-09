// Unit tests for planSoLineRelink — the PURE half of "a delete-and-reinsert of
// SO lines must not silently null every downstream so_item_id". Plan/apply are
// separated (the oversell-retrocost.ts precedent) precisely so the decision can
// be pinned here with no database in sight.
import { describe, expect, test } from 'vitest';
import {
  planSoLineRelink,
  soLineVariantSig,
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

/* docs/bugs/0672 SITE 11 — the bucket was the ITEM CODE alone.
 *
 * `SoLineIdentity` carried `{ id, itemCode, lineNo }` and nothing else, so two
 * lines of the SAME model in different fabrics — the ordinary sofa case, and
 * exactly what a TBC sofa exchange produces — fell into one bucket and were
 * paired by ORDINAL. If the exchange reorders them, the purchase order dedicated
 * to the BLUE two-seater is re-pointed at the GREY one. The link is valid, the
 * SKU matches, nothing dangles, and the floor is told the wrong sofa is covered.
 *
 * The fix is to make the bucket the identity: code AND the variant signature.
 * A line whose (code, variant) pair has no counterpart is DROPPED, which this
 * module already does for an unmatched SKU and already reports out loud — a
 * missing link is recoverable, a wrong one is not.
 */
describe('planSoLineRelink — the bucket is (code, variant), not code alone', () => {
  const v = (id: string, itemCode: string, colour: string, lineNo?: number): SoLineIdentity =>
    ({ id, itemCode, lineNo, variantSig: colour });

  test('pairs same-SKU lines by COLOUR, not by position', () => {
    /* The new build lists the two fabrics in the opposite order. Bucketed by
       code alone the ordinal zip swaps them; bucketed by identity it does not. */
    const plan = planSoLineRelink(
      [v('O-BLUE', 'PC151-2S', 'BLUE', 1), v('O-GREY', 'PC151-2S', 'GREY', 2)],
      [v('N-GREY', 'PC151-2S', 'GREY', 1), v('N-BLUE', 'PC151-2S', 'BLUE', 2)],
      [poLink('P-BLUE', 'O-BLUE'), poLink('P-GREY', 'O-GREY')],
    );
    const got = new Map(plan.restore.map((r) => [r.rowId, r.soItemId]));
    expect(got.get('P-BLUE')).toBe('N-BLUE');
    expect(got.get('P-GREY')).toBe('N-GREY');
    expect(plan.dropped).toHaveLength(0);
  });

  test('DROPS rather than guesses when the colour has no counterpart', () => {
    const plan = planSoLineRelink(
      [v('O-BLUE', 'PC151-2S', 'BLUE')],
      [v('N-GREY', 'PC151-2S', 'GREY')],
      [poLink('P-BLUE', 'O-BLUE')],
    );
    expect(plan.restore).toHaveLength(0);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0].oldSoItemId).toBe('O-BLUE');
  });

  test('still pairs ordinally within one (code, variant) bucket', () => {
    const plan = planSoLineRelink(
      [v('O1', 'PC151-2S', 'BLUE', 1), v('O2', 'PC151-2S', 'BLUE', 2)],
      [v('N1', 'PC151-2S', 'BLUE', 1), v('N2', 'PC151-2S', 'BLUE', 2)],
      [poLink('P1', 'O1'), poLink('P2', 'O2')],
    );
    const got = new Map(plan.restore.map((r) => [r.rowId, r.soItemId]));
    expect(got.get('P1')).toBe('N1');
    expect(got.get('P2')).toBe('N2');
  });

  test('a line with NO variant on either side behaves as before', () => {
    const plan = planSoLineRelink(
      [{ id: 'O1', itemCode: 'MATTRESS', lineNo: 1 }],
      [{ id: 'N1', itemCode: 'MATTRESS', lineNo: 1 }],
      [poLink('P1', 'O1')],
    );
    expect(plan.restore).toEqual([{ table: 'purchase_order_items', rowId: 'P1', soItemId: 'N1' }]);
  });
});

describe('soLineVariantSig', () => {
  test('reads the colour under any of the keys the importers actually write', () => {
    expect(soLineVariantSig({ colourId: 'abc' })).toBe(soLineVariantSig({ colourId: 'ABC' }));
    expect(soLineVariantSig({ colourLabel: 'PC151-01' })).toBe('PC151-01');
    expect(soLineVariantSig({ colourCode: 'PC151-01' })).toBe('PC151-01');
  });

  test('is empty when the line carries no colour at all, so non-sofa lines bucket as before', () => {
    expect(soLineVariantSig(null)).toBe('');
    expect(soLineVariantSig({})).toBe('');
  });

  test('prefers the id over the label, so a renamed colour does not re-bucket a line', () => {
    expect(soLineVariantSig({ colourId: 'id-1', colourLabel: 'Old Name' })).toBe('ID-1');
  });
});
