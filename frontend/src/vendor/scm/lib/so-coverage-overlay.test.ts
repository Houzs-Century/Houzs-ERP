/* THE COLUMN MUST NOT GO BLANK, AND MUST NOT GO BLANK EARLY.
 *
 * Two failures live here, in opposite directions:
 *   · no overlay at all — what shipped on 2026-09-01, when the SO list kept
 *     reading the base payload after #2834 moved the MRP fields to a separate
 *     call. Every "Incoming PO" chip that reads coverage went permanently blank.
 *   · an EMPTY overlay wiping the stored values — the fast first paint and the
 *     older-backend 404 both arrive as "no coverage yet", and blanking on those
 *     would make the column flicker off on every open.
 */
import { describe, expect, it } from 'vitest';
import { overlaySoLineCoverage, type CoverageOverlayFields } from './so-coverage-overlay';
import type { SoLineCoverage } from './sales-order-queries';
import { soLineStockPill, type SoLineSourceFields } from '../../../components/SoSourceChips';

/* Typed as the overlay's own field set so the assertions below read the fields
   the overlay WRITES, not only the ones this fixture happened to seed. */
type Line = CoverageOverlayFields & { item_code?: string };
const line = (id: string, extra: Partial<Line> = {}): Line =>
  ({ id, item_code: 'X', stock_status: 'PENDING', coverage_po: null, ready_source_pos: [], ...extra });

const cov = (id: string, extra: Partial<SoLineCoverage> = {}): SoLineCoverage => ({
  id, stock_state: 'po', coverage_po: 'HC-PO-009115', coverage_eta: '2026-10-01',
  ready_source_pos: [], stock_status_effective: 'PENDING', ...extra,
});

describe('overlaySoLineCoverage', () => {
  it('fills the incoming PO and its ETA — the whole point', () => {
    const [r] = overlaySoLineCoverage([line('a')], [cov('a')]);
    expect(r.coverage_po).toBe('HC-PO-009115');
    expect(r.coverage_eta).toBe('2026-10-01');
    expect(r.stock_state).toBe('po');
  });

  it('fills the READY source POs — chip 3, which has no ETA and still must show', () => {
    const ready = [{ po: 'HC-PO-000273', qty: 2, kind: 'po' as const }];
    const [r] = overlaySoLineCoverage([line('a')], [cov('a', { stock_state: 'stock', coverage_po: null, ready_source_pos: ready })]);
    expect(r.ready_source_pos).toEqual(ready);
  });

  it('leaves lines UNTOUCHED when no coverage has arrived — the fast first paint', () => {
    const src = [line('a', { coverage_po: 'STORED-PO' })];
    expect(overlaySoLineCoverage(src, undefined)).toBe(src);
    expect(overlaySoLineCoverage(src, [])).toBe(src);
  });

  it('leaves a line with no matching coverage row alone', () => {
    const [r] = overlaySoLineCoverage([line('a', { stock_status: 'READY' })], [cov('b')]);
    expect(r.stock_status).toBe('READY');
    expect(r.coverage_po).toBeNull();
  });

  it('a line carrying no id cannot match, and is returned unchanged', () => {
    const src: Line[] = [{ item_code: 'X', stock_status: 'READY' }];
    const [r] = overlaySoLineCoverage(src, [cov('a')]);
    expect(r.stock_status).toBe('READY');
  });

  it('keeps the stored status when coverage has no effective verdict', () => {
    const [r] = overlaySoLineCoverage([line('a', { stock_status: 'READY' })],
      [cov('a', { stock_status_effective: null })]);
    expect(r.stock_status).toBe('READY');
  });

  /* THE INVARIANT IS WHAT THE PILL RENDERS, NOT WHICH FIELD WAS WRITTEN.
   *
   * Every assertion above reads the overlay's output fields, and all of them
   * were green while the healed verdict never reached the screen: the overlay
   * wrote `stock_status`, the pill reads `stock_status_effective` FIRST, and
   * the base payload always populates that field (effectiveLineStockStatus
   * returns one of three strings, never null), so the `??` short-circuited and
   * the fallback branch reading `stock_status` was dead on both call sites.
   *
   * A test that pins the field name cannot see that. These pin the pill. */
  describe('the healed verdict reaches the pill', () => {
    /* The real payload shape: the base detail response carries a NON-NULL
       stale verdict, which is precisely what made the `??` short-circuit. */
    const staleReady = (): Line =>
      line('a', { stock_status: 'READY', stock_status_effective: 'READY' });

    it('a stale READY is corrected to PENDING when live coverage says so', () => {
      const [r] = overlaySoLineCoverage([staleReady()],
        [cov('a', { stock_state: 'po', stock_status_effective: 'PENDING' })]);
      expect(soLineStockPill(r as SoLineSourceFields)?.label).toBe('PENDING');
    });

    it('a stale PENDING is promoted to READY when live coverage says so', () => {
      const src = line('a', { stock_status: 'PENDING', stock_status_effective: 'PENDING' });
      const [r] = overlaySoLineCoverage([src],
        [cov('a', { stock_state: 'stock', stock_status_effective: 'READY' })]);
      expect(soLineStockPill(r as SoLineSourceFields)?.label).toBe('READY');
    });

    it('no coverage yet leaves the stored verdict standing — the first paint', () => {
      const [r] = overlaySoLineCoverage([staleReady()], undefined);
      expect(soLineStockPill(r as SoLineSourceFields)?.label).toBe('READY');
    });

    it('coverage with no verdict of its own does not blank the stored one', () => {
      const [r] = overlaySoLineCoverage([staleReady()],
        [cov('a', { stock_status_effective: null })]);
      expect(soLineStockPill(r as SoLineSourceFields)?.label).toBe('READY');
    });
  });
});
