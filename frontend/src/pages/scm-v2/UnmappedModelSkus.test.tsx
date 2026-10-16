// BUG-97: the SKU Pricing tab lists the codes a mapped Model gained, and maps
// only the ones ticked, through the existing /bindings/batch endpoint.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
const notified: string[] = [];
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({
  useNotify: () => async (opts: { title: string }) => { notified.push(opts.title); },
}));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import type { BindingRow } from '../../vendor/scm/lib/suppliers-queries';
import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { UnmappedModelSkus } from './UnmappedModelSkus';

const mockedFetch = vi.mocked(authedFetch);

const sku = (code: string): MfgProductRow => ({
  id: `id-${code}`, code, name: `SOFA VERANO ${code.slice(5)}`, category: 'SOFA',
  base_price_sen: null, price1_sen: null, status: 'ACTIVE', model_id: 'model-9028',
  base_model: '9028', unit_m3_milli: 0,
});
const bound = (item: string, supplierSku: string) => ({
  id: `b-${item}`, supplier_id: 'armani', material_kind: 'mfg_product', item_code: item,
  supplier_sku: supplierSku, currency: 'MYR', lead_time_days: 21, moq: 1,
  is_main_supplier: false, unit_price_sen: 0, price_matrix: null,
}) as unknown as BindingRow;

const products = ['9028-1A(LHF)', '9028-STOOL', '9028-2B(LHF)', '9028-2B(RHF)'].map(sku);
const bindings = [bound('9028-1A(LHF)', 'AMN-SF9028 SOFA 1A(LHF)')];

const mount = (b: BindingRow[] = bindings) => render(
  <QueryClientProvider client={new QueryClient()}>
    <UnmappedModelSkus supplierId="armani" bindings={b} products={products} />
  </QueryClientProvider>,
);

beforeEach(() => {
  notified.length = 0;
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue({ inserted: 2, skipped: 0, bindings: [] });
});

describe('UnmappedModelSkus', () => {
  test('says how many codes have no price row, and maps only the ticked ones', async () => {
    mount();
    expect(screen.getByText(/3 codes under Models this supplier already maps are not mapped here/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('AMN-SF9028 SOFA 2B(LHF)')).toBeTruthy();
    const map = screen.getByRole('button', { name: 'Map 0 selected' }) as HTMLButtonElement;
    expect(map.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /9028-2B\(LHF\)/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /9028-2B\(RHF\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Map 2 selected' }));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/suppliers/armani/bindings/batch');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.bindings.map((b: { itemCode: string; supplierSku: string }) => [b.itemCode, b.supplierSku])).toEqual([
      ['9028-2B(LHF)', 'AMN-SF9028 SOFA 2B(LHF)'],
      ['9028-2B(RHF)', 'AMN-SF9028 SOFA 2B(RHF)'],
    ]);
    await waitFor(() => expect(notified).toEqual(['Mapped 2 codes.']));
  });

  test('renders nothing when every code of the mapped Models is mapped', () => {
    const all = products.map((p) => bound(p.code, `AMN-SF9028 SOFA ${p.code.slice(5)}`));
    const { container } = mount(all);
    expect(container.textContent).toBe('');
  });
});
