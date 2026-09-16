/* HC-SO-011410 (owner 2026-09-15, 「为什么raise so amendment 还是会出来两个审批?」):
 * a no-change line must be dropped BEFORE the empty check and the lane split,
 * on the submit route and on the preview alike — otherwise a lane opens for a
 * desk that has nothing to sign, or the preview names one the submit will not
 * ask. The rule is pinned in lib/amendment-noop-lines.test.ts; this pins the
 * WIRING and its ORDER on the two handlers' source. */
import { describe, expect, it } from 'vitest';
/* `?raw`, not node:fs — backend/tsconfig.json types Workers only. */
import rawRoute from './mfg-sales-orders.ts?raw';
import rawPreview from './so-amendment-lane-preview.ts?raw';

const start = rawRoute.indexOf("mfgSalesOrders.post('/:docNo/amendments'");
const handler = start < 0 ? '' : rawRoute.slice(start, rawRoute.indexOf('\nmfgSalesOrders.', start + 10));

const order = (src: string, ...needles: string[]): number[] => needles.map((n) => src.indexOf(n));
const ascending = (xs: number[]) => xs.every((x, i) => x > -1 && (i === 0 || x > xs[i - 1]));

describe('the submit route drops no-op lines first', () => {
  it('finds the handler', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('drops no-op lines, refuses on a failed read, then checks emptiness, then splits lanes — in that order', () => {
    expect(ascending(order(handler,
      'await dropNoopAmendmentLines(sb, docNo,',
      'if (!noopSplit) return c.json(LINE_BUILD_ERRORS.unreadable, 500);',
      'const submittedLines = noopSplit.kept;',
      "error: 'amendment_empty'",
      'await resolveAmendmentLaneSplit(sb, docNo, activeCompanyId(c), headerChanges, submittedLines)',
    ))).toBe(true);
  });
});

describe('the lane preview drops the same lines before it splits', () => {
  it('carries every field the no-op test reads, drops, then splits what is kept', () => {
    for (const f of ['changeType', 'newVariants', 'newQty', 'newUnitPriceSen', 'newRemark', 'newDiscountSen']) {
      expect(rawPreview).toContain(`${f}:`);
    }
    expect(ascending(order(rawPreview,
      'await dropNoopAmendmentLines(sb, docNo, rawLines)',
      'await resolveAmendmentLaneSplit(sb, docNo, activeCompanyId(c), headerChanges, noopSplit.kept)',
    ))).toBe(true);
  });
});
