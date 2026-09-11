import { describe, it, expect } from 'vitest';
import { applySoScope, soDocOutOfScope } from '../src/scm/lib/salesScope';
import mfgSalesOrders from '../src/scm/routes/mfg-sales-orders.ts?raw';
import listEnrichment from '../src/scm/routes/mfg-sales-orders-list-enrichment.ts?raw';
import soAmendments from '../src/scm/routes/so-amendments.ts?raw';
import deliveryOrders from '../src/scm/routes/delivery-orders-mfg.ts?raw';
import salesInvoices from '../src/scm/routes/sales-invoices.ts?raw';
import deliveryReturns from '../src/scm/routes/delivery-returns.ts?raw';
import consignmentOrders from '../src/scm/routes/consignment-orders.ts?raw';
import reports from '../src/scm/routes/reports.ts?raw';
import arReconciliation from '../src/scm/routes/ar-reconciliation.ts?raw';
import unbilledDeliveries from '../src/scm/routes/unbilled-deliveries.ts?raw';

/* SHARED SALES ORDERS — the REACH ruling, pinned to the source.
 *
 * Owner 2026-09-09 ruled that a Sales Order may be shared with several
 * salespeople, and that the sharing reaches Sales Orders ONLY: the downstream
 * documents snapshot the rep who sold the order, which is what commission is
 * booked from (docs/modules/so-handover.md §8.3).
 *
 * That ruling lives in exactly one observable place — WHICH scope filter each
 * route calls — and nothing else would notice it being broken:
 *
 *   · an SO read left on `.in('salesperson_id', scopeIds)` does not fail. It
 *     silently hides shared orders from the person they were shared with, which
 *     reads as "the sharing did not work" and sends someone to debug the write.
 *   · a DELIVERY ORDER read moved onto `applySoScope` also does not fail. It
 *     widens who can see other reps' delivery orders, and nothing on screen says
 *     so.
 *
 * Both are silent, so they are asserted here rather than left to review.
 */

const SO_SIDE: Array<[string, string]> = [
  ['mfg-sales-orders.ts', mfgSalesOrders],
  ['mfg-sales-orders-list-enrichment.ts', listEnrichment],
  ['so-amendments.ts', soAmendments],
];

const DOWNSTREAM: Array<[string, string]> = [
  ['delivery-orders-mfg.ts', deliveryOrders],
  ['sales-invoices.ts', salesInvoices],
  ['delivery-returns.ts', deliveryReturns],
  ['consignment-orders.ts', consignmentOrders],
  ['reports.ts', reports],
  ['ar-reconciliation.ts', arReconciliation],
  ['unbilled-deliveries.ts', unbilledDeliveries],
];

/** Executable lines only — these files carry long comment blocks that quote the
 *  very filter expressions being asserted about, and a comment must not be able
 *  to satisfy or break a gate. */
const code = (source: string): string[] =>
  source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

describe('shared Sales Orders — the SO side honours sharing', () => {
  it.each(SO_SIDE)('%s scopes through applySoScope, never the raw column', (_name, source) => {
    const raw = code(source).filter((l) => l.includes("in('salesperson_id', scopeIds)"));
    expect(raw, 'an SO read left on the raw column hides shared orders in silence').toEqual([]);
    expect(source).toContain('applySoScope');
  });

  it('every SO detail/mutation gate asks soDocOutOfScope, which reads access_staff_ids', () => {
    for (const [name, source] of SO_SIDE) {
      const stale = code(source).filter((l) => l.includes('salesDocOutOfScope('));
      expect(stale, `${name} still calls the salesperson_id-only gate`).toEqual([]);
    }
    /* The gate is only as good as what it is fed: soDocOutOfScope falls back to
       the salespersonId test when accessStaffIds is absent, so a call site whose
       READ forgot the column would refuse collaborators and look fine. */
    for (const [name, source] of SO_SIDE) {
      const gates = code(source).filter((l) => l.includes('soDocOutOfScope('));
      for (const g of gates) {
        expect(g, `${name}: a gate that never passes accessStaffIds is a no-op for sharing`)
          .toContain('accessStaffIds');
      }
      if (gates.length > 0) expect(source).toContain('access_staff_ids');
    }
  });
});

describe('shared Sales Orders — the downstream documents do NOT inherit it', () => {
  it.each(DOWNSTREAM)('%s still scopes on salesperson_id alone', (_name, source) => {
    expect(
      code(source).some((l) => l.includes('applySoScope') || l.includes('access_staff_ids')),
      'a downstream document must not widen to SO collaborators — commission is booked off its own snapshot',
    ).toBe(false);
  });
});

/* OPEN-TO-ALL (owner 2026-09-11) — the same two helpers gain an `open_to_all`
 * bypass so the AutoCount-imported historical batch is visible to everyone. It
 * has the SAME reach as sharing (Sales Orders only) and the SAME silent-failure
 * shape: a gate that forgot to thread `openToAll` keeps open orders hidden, and
 * nothing on screen says so — so it is pinned here, not left to review. */
describe('open-to-all — the helpers bypass scope for flagged orders', () => {
  it('applySoScope leaves a view-all (null) scope unfiltered', () => {
    const q = { tag: 'unfiltered' };
    expect(applySoScope(q, null)).toBe(q);
  });

  it('applySoScope ORs the access_staff_ids overlap with open_to_all', () => {
    let captured = '';
    const q: { or: (s: string) => typeof q } = { or: (s: string) => { captured = s; return q; } };
    applySoScope(q, ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']);
    expect(captured).toContain(
      'access_staff_ids.ov.{11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222}',
    );
    expect(captured).toContain('open_to_all.is.true');
  });

  it('soDocOutOfScope: an open order is in scope for everyone, without a scope lookup', async () => {
    // openToAll short-circuits BEFORE resolveSalesScopeIds, so sb is never read;
    // a from() that throws proves the lookup did not run.
    const sb = { from: () => { throw new Error('scope lookup must not run for an open order'); } };
    const out = await soDocOutOfScope(sb, {} as never, 999, false, {
      salespersonId: 'a-stranger-uuid',
      accessStaffIds: [],
      openToAll: true,
    });
    expect(out).toBe(false);
  });
});

describe('open-to-all — reach is Sales Orders only, exactly like sharing', () => {
  it('every SO-side soDocOutOfScope gate threads openToAll', () => {
    for (const [name, source] of SO_SIDE) {
      const gates = code(source).filter((l) => l.includes('soDocOutOfScope('));
      for (const g of gates) {
        expect(g, `${name}: a gate that never passes openToAll keeps open orders hidden`)
          .toContain('openToAll');
      }
    }
  });

  it.each(DOWNSTREAM)('%s does not gain open_to_all reach', (_name, source) => {
    expect(
      code(source).some((l) => l.includes('open_to_all') || l.includes('openToAll')),
      'opening an order must not widen its downstream documents',
    ).toBe(false);
  });
});
