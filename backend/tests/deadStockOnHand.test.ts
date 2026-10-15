/* Owner report 2026-10-15 (2990s): dead stock is ON-HAND selling stock only.
 * KABBIN-2A(LHF) read "Dead 1" with 0 on hand because 5 incoming PO units beat
 * 4 scheduled SO units; XAMMAR-2A(RHF) showed a dead-stock banner for a free lot
 * sitting at KL SERVICE (away at the supplier). */
import { describe, it, expect } from 'vitest';
import { deadStockQty, isDeadStockLot } from '../src/scm/lib/non-selling-warehouse';
import inventoryRoute from '../src/scm/routes/inventory.ts?raw';

describe('dead stock = on-hand selling stock nobody claims', () => {
  it('0 on hand + incoming above demand is NOT dead (KABBIN-2A(LHF))', () => {
    // incoming is not a parameter at all: only on-hand can be dead
    expect(deadStockQty(0, 4, 0)).toBe(0);
  });
  it('on-hand above demand is dead, minus owned units in non-selling warehouses', () => {
    expect(deadStockQty(3, 1, 0)).toBe(2);
    expect(deadStockQty(3, 1, 2)).toBe(0);
  });
  it('a free owned lot in a service warehouse is NOT dead (XAMMAR-2A(RHF) at KL SERVICE)', () => {
    expect(isDeadStockLot(false, 1, 'service')).toBe(false);
    expect(isDeadStockLot(false, 1, 'showroom')).toBe(false);
  });
  it('a free owned lot in a selling warehouse IS dead', () => {
    expect(isDeadStockLot(false, 1, 'warehouse')).toBe(true);
    expect(isDeadStockLot(false, 1, null)).toBe(true);
  });
  it('consignment or fully assigned lots are never dead', () => {
    expect(isDeadStockLot(true, 1, 'warehouse')).toBe(false);
    expect(isDeadStockLot(false, 0, 'warehouse')).toBe(false);
  });
  it('the balances list and the reservations feed both go through the rule', () => {
    expect(inventoryRoute).toMatch(/sellable_surplus_qty: deadStockQty\(lotOwned, /);
    expect(inventoryRoute).toMatch(/is_dead_stock: isDeadStockLot\(isConsignment, freeQty, w\?\.type \?\? null\)/);
  });
});
