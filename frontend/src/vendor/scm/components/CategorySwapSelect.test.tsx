/* The category swap on the model / SKU edit screens: offered only between
 * Accessory and Sofa Accessory, and it PATCHes the right record. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn(async (_url: string, _init: unknown) => ({ ok: true }));
vi.mock('../lib/authed-fetch', () => ({ authedFetch: (u: string, i: unknown) => fetchMock(u, i) }));

const { CategorySwapSelect } = await import('./CategorySwapSelect');
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('CategorySwapSelect', () => {
  it('offers Accessory and Sofa Accessory for an accessory', () => {
    wrap(<CategorySwapSelect kind="model" id="m1" category="ACCESSORY" />);
    const opts = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['ACCESSORY', 'Sofa Accessory']);
  });

  it('renders nothing for a sofa', () => {
    const { container } = wrap(<CategorySwapSelect kind="model" id="m1" category="SOFA" />);
    expect(container.textContent).toBe('');
  });

  it('PATCHes the model when switched', async () => {
    wrap(<CategorySwapSelect kind="model" id="m1" category="ACCESSORY" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'FABRIC_ACCESSORY' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/product-models/m1');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body))).toEqual({ category: 'FABRIC_ACCESSORY' });
  });

  it('PATCHes the SKU for a model-less SKU', async () => {
    fetchMock.mockClear();
    wrap(<CategorySwapSelect kind="sku" id="s1" category="FABRIC_ACCESSORY" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'ACCESSORY' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/mfg-products/s1');
  });
});
