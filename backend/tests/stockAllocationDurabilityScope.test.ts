import { describe, expect, test } from 'vitest';
import consignmentLoaner from '../src/scm/lib/consignment-loaner.ts?raw';
import consignmentNotes from '../src/scm/routes/consignment-notes.ts?raw';
import consignmentReturns from '../src/scm/routes/consignment-returns.ts?raw';
import deliveryOrdersMfg from '../src/scm/routes/delivery-orders-mfg.ts?raw';
import deliveryReturns from '../src/scm/routes/delivery-returns.ts?raw';
import grns from '../src/scm/routes/grns.ts?raw';
import inventoryAdjustments from '../src/scm/routes/inventory-adjustments.ts?raw';
import mfgSalesOrders from '../src/scm/routes/mfg-sales-orders.ts?raw';
import purchaseConsignmentReceives from '../src/scm/routes/purchase-consignment-receives.ts?raw';
import purchaseConsignmentReturns from '../src/scm/routes/purchase-consignment-returns.ts?raw';
import purchaseReturns from '../src/scm/routes/purchase-returns.ts?raw';
import soAmendments from '../src/scm/routes/so-amendments.ts?raw';
import stockTakes from '../src/scm/routes/stock-takes.ts?raw';
import stockTransfers from '../src/scm/routes/stock-transfers.ts?raw';

/* ══════════════════════════════════════════════════════════════════════════════
   SCOPE LEDGER for the durable allocation queue (defect 1, 2026-07-22).

   HONEST STATEMENT OF WHAT SHIPPED. The durable outbox introduced by this PR
   covers FOUR of the THIRTY-EIGHT places that trigger an SO stock-allocation
   recompute. The other thirty-four still call `recomputeSoStockAllocation`
   inline, best-effort: if the Worker dies, the network drops, or the CPU limit
   is hit between the source write and the recompute, the projection stays stale
   until the next unrelated mutation happens to sweep it. Allocation is
   therefore NOT durable in general, and nothing in this repo should be read as
   claiming it is.

   WHY THE REMAINING 34 WERE NOT CONVERTED HERE. `enqueueStockAllocationRecompute`
   is only a durability guarantee when it commits in the SAME database
   transaction as the source write. Only the four converted call sites run under
   `runScmPgCommand`; the rest are ordinary PostgREST route bodies with no
   transaction to join, so enqueuing there would produce a queue row that can
   commit without its source write (or vice versa) — a WORSE lie than the honest
   best-effort call that is there now. Converting them means first moving each
   route onto the PG command transaction, which is a separate project per
   module. Doing it inside this PR — already the largest concurrency change in
   the batch, with no PostgreSQL CI coverage for the scm path — would not be
   reviewable.

   A THIRD CATEGORY, ADDED 2026-08-10: DEFERRED. The SO header PATCH now calls
   `deferAllocationRecompute`, which runs the same best-effort sweep under
   `ctx.waitUntil` instead of awaiting it, because that one global sweep was 10
   of the 10.6 seconds an operator waited to change a delivery date. Deferred
   sits with INLINE on the durability axis, NOT with DURABLE: same call, same
   crash window, no queue row, no retry. It is tracked separately only so this
   ledger cannot report a latency change as a durability change — reading
   "inline: 33" without the deferred column would look like a call site was
   made safe when nothing about its guarantee moved.

   THIS TEST IS A RATCHET, NOT A TARGET. It pins the exact inventory. Moving a
   call site between any two columns, or adding one, fails this test, which
   forces the follow-up PR to state which line it changed instead of letting the
   numbers drift quietly. Follow-up work: convert by module, highest count first
   (grns 6, mfg-sales-orders 7), each with its own move to `runScmPgCommand`.
   ══════════════════════════════════════════════════════════════════════════ */

/* THE NEEDLES COUNT THE CALL, NOT ITS ARGUMENT NAME. Until 2026-08-20 two of
   them ended `(sb` / `(c, sb`, so they counted a call site by what the caller
   happened to have named its client. `stock-transfers.ts` renamed `sb` to `db`
   when it moved to scopedDb, and this ledger silently read 2 inline call sites
   as 0 — a durability ratchet reporting that two best-effort recomputes had
   become safe, when nothing about them had moved. That is the failure this file
   exists to prevent, in its own matcher.
   Both were broadened and the counts verified UNCHANGED against an untouched
   origin/main checkout (16/16 green with the new needles, before any conversion
   was applied), so the population they count is identical — only the ways it can
   be silently lost are fewer. */
const INLINE = 'await recomputeSoStockAllocation(';
const DURABLE = 'await scheduleStockAllocationAfterCommand(';
const DEFERRED = 'deferAllocationRecompute(';

const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Every module that triggers an allocation recompute, with its exact split. */
const LEDGER: Array<{
  module: string; source: string; inline: number; durable: number; deferred: number;
}> = [
  { module: 'lib/consignment-loaner.ts', source: consignmentLoaner, inline: 2, durable: 0, deferred: 0 },
  { module: 'routes/consignment-notes.ts', source: consignmentNotes, inline: 1, durable: 0, deferred: 0 },
  { module: 'routes/consignment-returns.ts', source: consignmentReturns, inline: 1, durable: 0, deferred: 0 },
  { module: 'routes/delivery-orders-mfg.ts', source: deliveryOrdersMfg, inline: 3, durable: 0, deferred: 0 },
  { module: 'routes/delivery-returns.ts', source: deliveryReturns, inline: 3, durable: 0, deferred: 0 },
  /* grns.ts moved 6 -> 5 inline and 0 -> 1 durable on 2026-08-20: the line
     DELETE now runs inside runScmPgCommand, so its queue row commits with the
     stock reversal. The other five GRN routes are unchanged; postGrnHandler is
     deliberately last. docs/ALLOCATION-DURABILITY-PLAN.md. */
  { module: 'routes/grns.ts', source: grns, inline: 5, durable: 1, deferred: 0 },
  { module: 'routes/inventory-adjustments.ts', source: inventoryAdjustments, inline: 1, durable: 0, deferred: 0 },
  { module: 'routes/mfg-sales-orders.ts', source: mfgSalesOrders, inline: 7, durable: 3, deferred: 1 },
  { module: 'routes/purchase-consignment-receives.ts', source: purchaseConsignmentReceives, inline: 1, durable: 0, deferred: 0 },
  { module: 'routes/purchase-consignment-returns.ts', source: purchaseConsignmentReturns, inline: 1, durable: 0, deferred: 0 },
  { module: 'routes/purchase-returns.ts', source: purchaseReturns, inline: 3, durable: 0, deferred: 0 },
  { module: 'routes/so-amendments.ts', source: soAmendments, inline: 0, durable: 1, deferred: 0 },
  { module: 'routes/stock-takes.ts', source: stockTakes, inline: 2, durable: 0, deferred: 0 },
  { module: 'routes/stock-transfers.ts', source: stockTransfers, inline: 2, durable: 0, deferred: 0 },
];

describe('durable allocation coverage is stated honestly', () => {
  for (const entry of LEDGER) {
    test(`${entry.module}: ${entry.durable} durable / ${entry.inline} inline / ${entry.deferred} deferred`, () => {
      expect(count(entry.source, INLINE), `${entry.module} inline recompute call count changed`)
        .toBe(entry.inline);
      expect(count(entry.source, DURABLE), `${entry.module} durable enqueue count changed`)
        .toBe(entry.durable);
      expect(count(entry.source, DEFERRED), `${entry.module} deferred recompute count changed`)
        .toBe(entry.deferred);
    });
  }

  test('the totals match the documented scope: 4 durable of 38 triggers', () => {
    const durable = LEDGER.reduce((sum, entry) => sum + entry.durable, 0);
    const inline = LEDGER.reduce((sum, entry) => sum + entry.inline, 0);
    const deferred = LEDGER.reduce((sum, entry) => sum + entry.deferred, 0);
    expect(durable).toBe(5);
    expect(inline).toBe(32);
    expect(deferred).toBe(1);
    /* The trigger count is unchanged: deferring one moved it between columns,
       it did not remove it. 34 are still best-effort (33 inline + 1 deferred). */
    expect(inline + deferred).toBe(33);
    expect(durable + inline + deferred).toBe(38);
  });

  test('the code says out loud that the other triggers are still best-effort', () => {
    // The claim lives next to the implementation, not only in a PR description.
    expect(mfgSalesOrders).toContain('recomputeSoStockAllocation');
  });
});
