import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CostAnchorCard } from './CostAnchorCard';
import type { ProductCostAnchor } from '../../vendor/scm/lib/mfg-products-queries';

/* The Product Maintenance Cost anchor card — the four states from the approved
   SKU-drawer mockup. Renders on props alone (no router / query context), so the
   whole display decision is testable in isolation. Money is integer sen. */

const base: ProductCostAnchor = {
  state: 'ok',
  reason: null,
  anchorSupplierId: 'sup-1',
  anchorSupplierName: 'HOOKKA INDUSTRIES',
  costSen: 106000,
  costedCount: 1,
  totalCount: 1,
};

const renderCard = (anchor: ProductCostAnchor, onOpen = vi.fn(), fallback: string | null = null) =>
  render(<CostAnchorCard anchor={anchor} onOpenSupplier={onOpen} fallbackSupplierId={fallback} />);

describe('CostAnchorCard', () => {
  it('ok, single supplier: shows the cost, "Anchored", the supplier and "only supplier"', () => {
    renderCard(base);
    expect(screen.getByText('RM 1,060.00')).toBeTruthy();
    expect(screen.getByText('Anchored')).toBeTruthy();
    expect(screen.getByText('HOOKKA INDUSTRIES')).toBeTruthy();
    expect(screen.getByText('only supplier')).toBeTruthy();
  });

  it('ok, several suppliers agree: shows "highest full set (N of M)"', () => {
    renderCard({ ...base, costedCount: 2, totalCount: 3 });
    expect(screen.getByText('highest full set (2 of 3)')).toBeTruthy();
  });

  it('conflict: amber "took highest" and a Review / fix action that opens the anchor supplier', () => {
    const onOpen = vi.fn();
    renderCard({ ...base, state: 'conflict', costedCount: 2, totalCount: 2 }, onOpen);
    expect(screen.getByText('Suppliers differ · took highest')).toBeTruthy();
    fireEvent.click(screen.getByText('Review / fix'));
    expect(onOpen).toHaveBeenCalledWith('sup-1');
  });

  it('empty with a bound supplier: red gap, blank-price copy, Fix in Binding opens that supplier', () => {
    const onOpen = vi.fn();
    renderCard(
      { ...base, state: 'empty', reason: 'no_supplier_with_cost', anchorSupplierId: null, anchorSupplierName: null, costSen: null, costedCount: 0, totalCount: 1 },
      onOpen,
      'sup-9',
    );
    expect(screen.getByText('Missing price · binding gap')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
    fireEvent.click(screen.getByText('Fix in Binding'));
    expect(onOpen).toHaveBeenCalledWith('sup-9');
  });

  it('empty with nothing bound: prompts to add a supplier, no Fix button', () => {
    renderCard(
      { ...base, state: 'empty', reason: 'no_supplier_binding', anchorSupplierId: null, anchorSupplierName: null, costSen: null, costedCount: 0, totalCount: 0 },
      vi.fn(),
      null,
    );
    expect(screen.getByText(/No supplier is bound yet/)).toBeTruthy();
    expect(screen.queryByText('Fix in Binding')).toBeNull();
  });

  it('service: "Service item", no cost figure, no supplier anchor', () => {
    renderCard({ ...base, state: 'service', anchorSupplierId: null, anchorSupplierName: null, costSen: null, costedCount: 0, totalCount: 0 });
    expect(screen.getByText('Service item')).toBeTruthy();
    expect(screen.getByText(/not priced from suppliers/)).toBeTruthy();
  });

  it('cost hidden (finance-gated, costSen null) still shows the anchor and state', () => {
    renderCard({ ...base, costSen: null });
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('Anchored')).toBeTruthy();
    expect(screen.getByText('HOOKKA INDUSTRIES')).toBeTruthy();
  });
});
