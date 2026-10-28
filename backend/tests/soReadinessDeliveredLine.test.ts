import { describe, expect, test } from "vitest";
import { summariseReadiness, type ReadinessLine } from "../src/scm/lib/so-readiness";

/* A LINE THAT HAS SHIPPED CANNOT BE WAITING FOR STOCK.
 *
 * recomputeSoStockAllocation computes `remaining = qty - delivered + returned`
 * and skips the line at `remaining <= 0` — correctly, there is nothing left to
 * allocate. The consequence is that `stock_status` on a delivered line is
 * FROZEN at whatever it last was, and for goods that shipped straight off a
 * purchase order that is usually PENDING.
 *
 * The allocator's own header rollup then reads that frozen value. Its comment
 * says the opposite of what it does:
 *
 *     "lines that weren't in needs are already shipped -> treat as READY"
 *     stock_status: targetStatusById.get(l.id) ?? l.stock_status
 *
 * A shipped line is not in `needs`, so `targetStatusById` has no entry for it
 * and the `??` falls through to the stale stored PENDING. The order therefore
 * never advances to READY_TO_SHIP even when every line still owing goods is
 * allocated.
 *
 * Measured on prod 2026-09-09 (company 1, read-only): 60 live orders carry at
 * least one delivered line whose stored status is not READY, and on 18 of them
 * EVERY still-outstanding line is READY — so 18 orders are held out of the ship
 * queue by lines whose goods are already at the customer.
 *
 * The fix models it honestly rather than by writing 'READY' onto a line that is
 * not ready but DONE: `fulfilled` is counted like a SERVICE line — it keeps the
 * order from looking like an empty husk, and it gates nothing.
 */

const main = (stock_status: string, extra: Partial<ReadinessLine> = {}): ReadinessLine =>
  ({ item_group: "MATTRESS", stock_status, ...extra });
const acc = (stock_status: string, extra: Partial<ReadinessLine> = {}): ReadinessLine =>
  ({ item_group: "ACCESSORIES", stock_status, ...extra });

describe("a delivered line does not gate readiness", () => {
  test("the shipped line's stale PENDING no longer holds the order back", () => {
    const r = summariseReadiness([main("READY"), main("PENDING", { fulfilled: true })]);
    expect(r.isMainReady).toBe(true);
    expect(r.isShipReady).toBe(true);
    /* It is not counted as a main line waiting on stock... */
    expect(r.mainCount).toBe(1);
    expect(r.mainReady).toBe(1);
  });

  test("an accessory that has shipped does not keep the order 'not fully ready'", () => {
    const r = summariseReadiness([main("READY"), acc("PENDING", { fulfilled: true })]);
    expect(r.isFullyReady).toBe(true);
  });

  test("WITHOUT the flag the line still gates - absence is the STRICTER direction", () => {
    const r = summariseReadiness([main("READY"), main("PENDING")]);
    expect(r.isShipReady).toBe(false);
  });

  test("an order whose every line has shipped is NOT mistaken for an empty husk", () => {
    /* The empty-SO gate (soShipGate.test.ts) must keep refusing a document with
       no lines, while an order that is simply finished still reads ship-ready.
       Counting the fulfilled line - rather than `continue`-ing past it - is what
       separates the two, exactly as SERVICE lines are counted. */
    const finished = summariseReadiness([main("PENDING", { fulfilled: true })]);
    const husk = summariseReadiness([]);
    expect(finished.isShipReady).toBe(true);
    expect(husk.isShipReady).toBe(false);
  });

  test("a still-outstanding short line is unaffected by a delivered sibling", () => {
    const r = summariseReadiness([main("PENDING"), main("READY", { fulfilled: true })]);
    expect(r.isShipReady).toBe(false);
  });
});
