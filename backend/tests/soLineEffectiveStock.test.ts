/* The owner's 2026-08-16 report, as tests.
 *
 * 2990-SO-2608-002 carried a mattress line stored PENDING while the LIVE MRP
 * verdict for the same line was 'stock' — the goods were in the warehouse. The
 * list rolled up the STORED value and printed `SHORT: MATTRESS`; the drill-down
 * pill one click away rendered the LIVE value and said the stock was there.
 * Both cells are "the stock status" to him.
 *
 * These pin the union rule and, through the `?raw` assertions at the bottom,
 * that the SO list actually goes through it. The label VOCABULARY is not
 * asserted anywhere here — soReadinessRemark.test.ts owns that, and it moved
 * twice on 2026-08-16 (#2295 inverted it, #2334 restored it). What is pinned is
 * that the rule is fed the same input the pill shows.
 */
import { describe, it, expect } from 'vitest';
import mfgSalesOrders from '../src/scm/routes/mfg-sales-orders.ts?raw';
import { effectiveLineStockStatus } from '../src/scm/lib/so-line-effective-stock';
import { summariseReadiness } from '../src/scm/lib/so-readiness';

describe('effectiveLineStockStatus — the one verdict both surfaces answer from', () => {
  it('stale stored PENDING + live stock => READY (2990-SO-2608-002)', () => {
    expect(effectiveLineStockStatus('PENDING', 'stock')).toBe('READY');
  });

  it('stored READY + live shortage stays READY — MRP cannot see bound mode or a dye lot', () => {
    /* The allocator's BOUND MODE and the sofa batch matcher both make a line
       ready off evidence computeMrp structurally does not hold (a dedicated
       received PO; one batch covering a whole set). Letting the live verdict
       VETO the stored one would report a bedframe that is standing in the
       warehouse as short — the exact failure the bound-mode comment in
       so-stock-allocation.ts was written to prevent. */
    expect(effectiveLineStockStatus('READY', 'shortage')).toBe('READY');
    expect(effectiveLineStockStatus('READY', 'po')).toBe('READY');
  });

  it('live po / shortage cannot promote a PENDING line — an incoming PO is not stock', () => {
    expect(effectiveLineStockStatus('PENDING', 'po')).toBe('PENDING');
    expect(effectiveLineStockStatus('PENDING', 'shortage')).toBe('PENDING');
  });

  it('PARTIAL survives when nothing outranks it', () => {
    expect(effectiveLineStockStatus('PARTIAL', 'shortage')).toBe('PARTIAL');
    expect(effectiveLineStockStatus('PARTIAL', null)).toBe('PARTIAL');
    // ... but goods on hand beat a part-fill
    expect(effectiveLineStockStatus('PARTIAL', 'stock')).toBe('READY');
  });

  it('a null live verdict leaves the stored value standing (MRP failed / line absent)', () => {
    expect(effectiveLineStockStatus('PENDING', null)).toBe('PENDING');
    expect(effectiveLineStockStatus('READY', null)).toBe('READY');
    /* Fail-soft is the WHOLE compatibility story: computeMrp is best-effort in
       both handlers, and when it throws every line is handed null. That must
       reproduce the pre-2026-08-17 behaviour exactly, not a third one. */
    expect(effectiveLineStockStatus(null, null)).toBe('PENDING');
    expect(effectiveLineStockStatus(undefined, null)).toBe('PENDING');
  });

  it('stored status is matched case-insensitively', () => {
    expect(effectiveLineStockStatus('ready', 'shortage')).toBe('READY');
    expect(effectiveLineStockStatus('partial', null)).toBe('PARTIAL');
  });
});

describe('the rollup the owner reads, fed the two ways', () => {
  /* 2990-SO-2608-002 as reported: one mattress line, stored PENDING, live
     'stock'. The mattress is physically in the warehouse. */
  const so002 = { item_group: 'MATTRESS', item_code: '2990 AKKA-SOFT MATT (Q)', stored: 'PENDING', live: 'stock' as const };
  /* 2990-SO-2608-003: one bedframe, stored PENDING, live 'po' with a covering
     PO and an ETA. Genuinely short — the label was RIGHT on this one. */
  const so003 = { item_group: 'BEDFRAME', item_code: 'LYRA-(K)', stored: 'PENDING', live: 'po' as const };

  /* NOTHING HERE ASSERTS THE WORDS, and that is deliberate. The label
     vocabulary changed TWICE on 2026-08-16 — #2295 inverted it to name what was
     missing (`SHORT: MATTRESS`, which is the string the owner quoted) and #2334
     restored the what-IS-ready side the same day. soReadinessRemark.test.ts owns
     the wording. This suite owns the INPUT, so it must survive a third ruling:
     it asserts that the two feeds DIFFER, and that the effective feed lands on
     whatever the rollup says for a line whose stock is in. */
  const roll = (l: { item_group: string; item_code: string }, status: string) =>
    summariseReadiness([{ item_group: l.item_group, item_code: l.item_code, stock_status: status }]);
  const fromStored = (l: typeof so002 | typeof so003) => roll(l, l.stored);
  const fromEffective = (l: typeof so002 | typeof so003) => roll(l, effectiveLineStockStatus(l.stored, l.live));

  it('2608-002: the stored feed and the effective feed disagree, and the effective one is right', () => {
    // The board and the drill-down really did say different things about this order.
    expect(fromStored(so002).stockRemark).not.toBe(fromEffective(so002).stockRemark);
    // The effective feed says exactly what an in-stock mattress should say...
    expect(fromEffective(so002).stockRemark).toBe(roll(so002, 'READY').stockRemark);
    // ... and the SHIP GATE flips with it, which is the claim that has no wording in it.
    expect(fromStored(so002).isShipReady).toBe(false);
    expect(fromEffective(so002).isShipReady).toBe(true);
  });

  it('2608-003 does NOT move — an incoming PO is not stock, and that label was correct', () => {
    expect(fromEffective(so003).stockRemark).toBe(fromStored(so003).stockRemark);
    expect(fromEffective(so003).isShipReady).toBe(false);
  });

  it('the two orders together still roll up independently', () => {
    const both = summariseReadiness([
      { item_group: so002.item_group, item_code: so002.item_code, stock_status: effectiveLineStockStatus(so002.stored, so002.live) },
      { item_group: so003.item_group, item_code: so003.item_code, stock_status: effectiveLineStockStatus(so003.stored, so003.live) },
    ]);
    // One line in, one line short: still not ship-able, whatever it is called.
    expect(both.isShipReady).toBe(false);
    expect(both.mainReady).toBe(1);
    expect(both.mainCount).toBe(2);
  });
});

/* Source assertions, the same idiom stockAllocationDurabilityScope.test.ts uses.
   The rule above is only worth anything if the LIST goes through it — the whole
   defect was a surface holding a second opinion, and a green unit test on a
   helper nobody calls is exactly how that ships again. */
describe('the SO list rolls up the shared rule, not a raw stored column', () => {
  it('the list readiness rollup is fed the effective status, not the stored column', () => {
    // The rollup's input is built by the shared module, with the live coverage.
    expect(mfgSalesOrders).toContain('readinessLinesByDoc(itemRows ?? [], mrpForList ? mrpLineCoverage(mrpForList) : null)');
    /* The pre-fix shape: the handler building ReadinessLine rows itself off the
       raw stored column. If any of these comes back the board has its own
       opinion again, which is the whole defect. */
    expect(mfgSalesOrders).not.toContain('stock_status: it.stock_status, cancelled:');
    expect(mfgSalesOrders).not.toContain('stock_status: it.stock_status });');
  });

  it('both line-detail handlers publish the verdict, so the pill cannot compute its own', () => {
    // GET /:docNo and GET /:docNo/items — two handlers, one rule.
    expect(mfgSalesOrders.split('stock_status_effective:').length - 1).toBe(2);
  });

  it('the MRP result the rollup reads is the one the handler already awaited', () => {
    /* Not decoration: if this ever becomes a SECOND computeMrp the column costs
       a full MRP run per list render, which is the thing the perf work on this
       endpoint exists to remove. mrpLineCoverage is a pure flatten. */
    expect(mfgSalesOrders).toContain('const mrpForList = await mrpForListProm;');
    expect(mfgSalesOrders.split('computeMrp(').length - 1).toBe(2); // one per handler family, unchanged
  });
});
