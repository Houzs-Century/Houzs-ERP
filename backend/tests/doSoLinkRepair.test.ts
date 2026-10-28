// Unit tests for planDoSoLinkRepair — the PURE decision behind
// backend/scripts/repair-do-so-item-links.mjs.
//
// The repair re-points Delivery-Order lines whose so_item_id the FK's
// `ON DELETE SET NULL` wiped. What is worth testing is not the happy path but
// the REFUSALS: a wrong link reports someone else's shipment as this order's,
// and every downstream consumer (MRP netting, the DELIVERED flip, drop-ship
// batch resolution, costing) trusts it as fact.
//
// @ts-expect-error — plain .mjs module with no type declarations.
import { planDoSoLinkRepair } from '../scripts/lib/do-so-link-repair.mjs';
import { describe, it, expect } from 'vitest';

type Line = { id: string; itemCode: string; qty: number };
type Plan = {
  restore: Array<{ doItemId: string; soItemId: string; itemCode: string; qty: number }>;
  refused: Array<{ doItemId: string; itemCode: string; qty: number; reason: string }>;
};
const plan = (
  orphans: Line[],
  soLines: Line[],
  claimed: string[] = [],
): Plan => planDoSoLinkRepair(orphans, soLines, claimed) as Plan;

describe('planDoSoLinkRepair', () => {
  it('re-points a line when exactly one SO line carries that SKU and qty', () => {
    const p = plan(
      [{ id: 'do-1', itemCode: 'BARON-(K)', qty: 1 }],
      [{ id: 'so-1', itemCode: 'BARON-(K)', qty: 1 }, { id: 'so-2', itemCode: 'SVC-DELIVERY', qty: 1 }],
    );
    expect(p.restore).toEqual([{ doItemId: 'do-1', soItemId: 'so-1', itemCode: 'BARON-(K)', qty: 1 }]);
    expect(p.refused).toEqual([]);
  });

  it('matches item codes case- and space-insensitively, like so-line-relink', () => {
    const p = plan(
      [{ id: 'do-1', itemCode: '  baron-(k) ', qty: 1 }],
      [{ id: 'so-1', itemCode: 'BARON-(K)', qty: 1 }],
    );
    expect(p.restore).toHaveLength(1);
    expect(p.restore[0].soItemId).toBe('so-1');
  });

  it('refuses an SO line another delivery already claims (the 2606-030 pillow)', () => {
    // Ordered qty 1, already delivered by 2990-DO-2608-010; a second orphaned
    // line for the same pillow sits on 2990-DO-2607-013. Linking it would read
    // as 2 delivered against 1 ordered.
    const p = plan(
      [{ id: 'do-orphan', itemCode: 'NTYR MEMORY CONTOUR PILLOW', qty: 1 }],
      [{ id: 'so-1', itemCode: 'NTYR MEMORY CONTOUR PILLOW', qty: 1 }],
      ['so-1'],
    );
    expect(p.restore).toEqual([]);
    expect(p.refused).toEqual([
      { doItemId: 'do-orphan', itemCode: 'NTYR MEMORY CONTOUR PILLOW', qty: 1, reason: 'all_candidate_so_lines_already_delivered' },
    ]);
  });

  it('refuses when two free SO lines of the same SKU and qty could both be it', () => {
    const p = plan(
      [{ id: 'do-1', itemCode: 'XAMMAR-2A(RHF)', qty: 1 }],
      [{ id: 'so-1', itemCode: 'XAMMAR-2A(RHF)', qty: 1 }, { id: 'so-2', itemCode: 'XAMMAR-2A(RHF)', qty: 1 }],
    );
    expect(p.restore).toEqual([]);
    expect(p.refused[0].reason).toBe('ambiguous_multiple_candidate_so_lines');
  });

  it('never gives two orphaned lines the same SO line', () => {
    // Two same-SKU orphans, two same-SKU SO lines: each orphan sees two
    // candidates, so BOTH are ambiguous. The point is that no plan is produced
    // in which one SO line is handed out twice.
    const p = plan(
      [{ id: 'do-1', itemCode: 'PILLOW', qty: 1 }, { id: 'do-2', itemCode: 'PILLOW', qty: 1 }],
      [{ id: 'so-1', itemCode: 'PILLOW', qty: 1 }, { id: 'so-2', itemCode: 'PILLOW', qty: 1 }],
    );
    const usedSoIds = p.restore.map((r) => r.soItemId);
    expect(new Set(usedSoIds).size).toBe(usedSoIds.length);
    expect(p.refused).toHaveLength(2);
  });

  it('refuses a partial shipment — an unequal qty cannot identify which line it served', () => {
    const p = plan(
      [{ id: 'do-1', itemCode: 'PILLOW', qty: 2 }],
      [{ id: 'so-1', itemCode: 'PILLOW', qty: 4 }],
    );
    expect(p.restore).toEqual([]);
    expect(p.refused[0].reason).toBe('no_so_line_with_matching_qty');
  });

  it('refuses an ad-hoc line the SO never carried', () => {
    const p = plan(
      [{ id: 'do-1', itemCode: 'FREE-SAMPLE', qty: 1 }],
      [{ id: 'so-1', itemCode: 'BARON-(K)', qty: 1 }],
    );
    expect(p.restore).toEqual([]);
    expect(p.refused[0].reason).toBe('no_so_line_with_that_item_code');
  });

  it('plans the whole of 2990-DO-2608-008 — the seven lines that started this', () => {
    const so: Line[] = [
      { id: 'so-0', itemCode: '2990 ARRUS-SOFT MATT (K)', qty: 1 },
      { id: 'so-1', itemCode: '2990 ARRUS-SOFT MATT (Q)', qty: 1 },
      { id: 'so-2', itemCode: 'BARON-(K)', qty: 1 },
      { id: 'so-3', itemCode: '2990S WP MP (K)', qty: 1 },
      { id: 'so-4', itemCode: 'NTYR MEMORY CONTOUR PILLOW', qty: 4 },
      { id: 'so-5', itemCode: '2990S WP MP (Q)', qty: 1 },
      { id: 'so-6', itemCode: 'SVC-DELIVERY-CROSS', qty: 1 },
    ];
    const p = plan(so.map((l, i) => ({ ...l, id: `do-${i}` })), so);
    expect(p.refused).toEqual([]);
    expect(p.restore.map((r) => r.soItemId)).toEqual(['so-0', 'so-1', 'so-2', 'so-3', 'so-4', 'so-5', 'so-6']);
  });

  it('returns an empty plan for an empty input rather than throwing', () => {
    expect(plan([], [])).toEqual({ restore: [], refused: [] });
  });
});
