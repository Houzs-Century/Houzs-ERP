/* DEV-62 (Adrian): an RM 0 Unit Price, on a new line or a saved one being
 * edited, shows blank with "0.00" as the placeholder, so typing a price does
 * not begin with deleting "0.00". */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/mfg-products-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isSuccess: true, isFetching: false }),
  useMaintenanceConfig: () => ({ data: undefined }),
  useSpecialAddons: () => ({ data: [] }),
  useModelAllowedOptionsByCode: () => ({ data: null }),
  useSkuCategoryByCode: () => ({ data: 'SOFA' }),
}));
vi.mock('../lib/fabric-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/fabric-queries')>()),
  useFabricTrackingsLite: () => ({ data: [] }),
  useFabricColoursSearch: () => ({ data: [], isFetching: false }),
}));
vi.mock('../lib/queries', async (orig) => ({
  ...(await orig<typeof import('../lib/queries')>()),
  useFabricLibrary: () => ({ data: [] }),
}));
vi.mock('../lib/sales-order-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/sales-order-queries')>()),
  useUploadSoItemPhoto: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSoItemPhoto: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../lib/auth', async (orig) => ({
  ...(await orig<typeof import('../lib/auth')>()),
  useAuth: () => ({ staff: { id: 1, role: 'admin' } }),
}));
vi.mock('./NotifyDialog', () => ({ useNotify: () => vi.fn() }));

const { SoLineCard } = await import('./SoLineCard');
type Draft = Parameters<typeof SoLineCard>[0]['draft'];

const base: Draft = {
  itemCode: 'SOFFIO-1A(RHF)', itemGroup: 'sofa', description: 'SOFA SOFFIO 1A(RHF)', uom: 'UNIT',
  qty: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0, remark: '', variants: {},
  lineDeliveryDate: null,
};

function Harness({ initial }: { initial: Draft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
    <output data-testid="unit-price-sen">{draft.unitPriceSen}</output>
    <SoLineCard
      index={1}
      draft={draft}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      onRemove={() => {}}
      canRemove
      isEditing
      variantsRequired
      seedSofaLegDefault
      lineDateLocked={false}
      attachOptions={null}
    />
    </>
  );
}

const priceBox = () => screen.getByPlaceholderText('0.00') as HTMLInputElement;
const linePriceSen = () => screen.getByTestId('unit-price-sen').textContent;

describe('SO line card — an RM 0 Unit Price', () => {
  it('starts blank, with 0.00 as the placeholder', () => {
    render(<Harness initial={base} />);
    expect(priceBox().value).toBe('');
  });

  it('takes a typed price without deleting anything first', () => {
    render(<Harness initial={base} />);
    fireEvent.change(priceBox(), { target: { value: '3800' } });
    expect(priceBox().value).toBe('3800');
    fireEvent.blur(priceBox());
    expect(priceBox().value).toBe('3800.00');
  });

  it('shows a 0 while it is typed, so 0.5 can be keyed in, then falls back to the placeholder', () => {
    render(<Harness initial={base} />);
    fireEvent.change(priceBox(), { target: { value: '0' } });
    expect(priceBox().value).toBe('0');
    fireEvent.change(priceBox(), { target: { value: '0.' } });
    expect(priceBox().value).toBe('0.');
    fireEvent.change(priceBox(), { target: { value: '0' } });
    fireEvent.blur(priceBox());
    expect(priceBox().value).toBe('');
  });

  it('a saved RM 0 line (edit mode) is blank too', () => {
    render(<Harness initial={{ ...base, priceAuthored: true }} />);
    expect(priceBox().value).toBe('');
  });

  it('shows a SKU sell price as before', () => {
    render(<Harness initial={{ ...base, unitPriceSen: 380000 }} />);
    expect(priceBox().value).toBe('3800.00');
  });
});

/* HC-0095: an emptied box requests no new price (priceBoxAuthored), so the line
 * must keep showing the price it had, not RM 0.00 it will never be charged. */
describe('SO line card — an emptied price box', () => {
  it('keeps the saved price on the line, and refills the box on blur', () => {
    render(<Harness initial={{ ...base, unitPriceSen: 25000, priceAuthored: true }} />);
    fireEvent.change(priceBox(), { target: { value: '' } });
    expect(priceBox().value).toBe('');
    expect(linePriceSen()).toBe('25000');
    fireEvent.blur(priceBox());
    expect(priceBox().value).toBe('250.00');
  });

  it('typed, then emptied, goes back to the price before the edit', () => {
    render(<Harness initial={{ ...base, unitPriceSen: 25000, priceAuthored: true }} />);
    fireEvent.change(priceBox(), { target: { value: '300' } });
    expect(linePriceSen()).toBe('30000');
    fireEvent.change(priceBox(), { target: { value: '' } });
    expect(priceBox().value).toBe('');
    expect(linePriceSen()).toBe('25000');
  });

  it('a typed 0 is still RM 0', () => {
    render(<Harness initial={{ ...base, unitPriceSen: 25000, priceAuthored: true }} />);
    fireEvent.change(priceBox(), { target: { value: '0' } });
    expect(linePriceSen()).toBe('0');
  });
});
