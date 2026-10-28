import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/* SkuHistoryTabs renders the active tab's rows from three hooks. Mock the hooks
   so the tabs can be exercised without a server; fmtSen (money) stays real. */
const data = vi.hoisted(() => ({
  cost: {
    isLoading: false,
    data: { history: [{ id: 'c1', effectiveFrom: '2026-09-16', basePriceSen: 106000, price1Sen: null, seatHeightPrices: null, sourceSupplierId: 's1', sourceSupplierName: 'HOOKKA INDUSTRIES', notes: null, createdBy: null, createdAt: '' }] },
  },
  supplier: {
    isLoading: false,
    data: { history: [
      { id: 'p1', supplierId: 's1', supplierCode: '400-H004', supplierName: 'HOOKKA INDUSTRIES', isMainSupplier: true, unitPriceSen: 106000, priceMatrix: null, comparableSen: 106000, direction: 'up', effectiveFrom: '2026-09-16', notes: null, createdBy: null, createdAt: '' },
    ] },
  },
  selling: {
    isLoading: false,
    data: { history: [{ id: 'x1', effective_from: '2026-09-16', sell_price_sen: 118000, notes: null, created_by: null, created_at: '' }], currentSellPriceSen: 118000, pending: null },
  },
}));

vi.mock('../../vendor/scm/lib/mfg-products-queries', () => ({
  useMfgProductCostHistory: () => data.cost,
  useMfgProductSupplierPriceHistory: () => data.supplier,
  useMfgProductPriceChanges: () => data.selling,
}));

import { SkuHistoryTabs } from './SkuHistoryTabs';

describe('SkuHistoryTabs', () => {
  it('defaults to the Cost tab: derived cost + which supplier anchored it', () => {
    render(<SkuHistoryTabs productId="prod-1" />);
    expect(screen.getByText('Anchored cost')).toBeTruthy();
    expect(screen.getByText('RM 1,060.00')).toBeTruthy();
    expect(screen.getByText(/From HOOKKA INDUSTRIES/)).toBeTruthy();
  });

  it('Supplier price tab shows the supplier and a raised arrow', () => {
    render(<SkuHistoryTabs productId="prod-1" />);
    fireEvent.click(screen.getByText('Supplier price'));
    expect(screen.getByText('↑ raised')).toBeTruthy();
    expect(screen.getByText(/main supplier/)).toBeTruthy();
  });

  it('Selling tab shows the scheduled selling price', () => {
    render(<SkuHistoryTabs productId="prod-1" />);
    fireEvent.click(screen.getByText('Selling'));
    expect(screen.getByText('RM 1,180.00')).toBeTruthy();
  });
});
