/* The category picker on the model / SKU edit screens: every category is
 * offered under its one label, a move asks first (saying open orders keep the
 * old category), and it PATCHes the right record only when confirmed. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from './ConfirmDialog';

const fetchMock = vi.fn(async (_url: string, _init: unknown) => ({ ok: true }));
vi.mock('../lib/authed-fetch', () => ({ authedFetch: (u: string, i: unknown) => fetchMock(u, i) }));

const { CategorySwapSelect } = await import('./CategorySwapSelect');
const wrap = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient()}><ConfirmProvider>{ui}</ConfirmProvider></QueryClientProvider>,
);

describe('CategorySwapSelect', () => {
  beforeEach(() => fetchMock.mockClear());

  it('offers every category, labelled, for any category — a sofa too', () => {
    wrap(<CategorySwapSelect kind="model" id="m1" category="SOFA" />);
    const opts = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['Sofa', 'Bedframe', 'Accessory', 'Sofa Accessory', 'Mattress', 'Bedlines', 'Dining', 'Diffuser', 'Carpet', 'Service']);
  });

  it('asks first, says open orders keep the old category, and PATCHes the model on Move', async () => {
    wrap(<CategorySwapSelect kind="model" id="m1" category="ACCESSORY" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'MATTRESS' } });
    expect(await screen.findByText(/Orders already written keep the old category/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/product-models/m1');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body))).toEqual({ category: 'MATTRESS' });
  });

  it('Cancel leaves the category alone and sends nothing', async () => {
    wrap(<CategorySwapSelect kind="sku" id="s1" category="FABRIC_ACCESSORY" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'ACCESSORY' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Orders already written/)).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('FABRIC_ACCESSORY');
  });

  it('PATCHes the SKU for a model-less SKU', async () => {
    wrap(<CategorySwapSelect kind="sku" id="s1" category="FABRIC_ACCESSORY" />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'SOFA' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/mfg-products/s1');
  });
});
