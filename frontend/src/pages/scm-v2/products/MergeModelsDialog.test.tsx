import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MergeModelsButton, MergeModelsDialog } from './MergeModelsDialog';

const fetcher = vi.hoisted(() => vi.fn());
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: fetcher }));

const plan = (over: object) => ({
  refusals: [], pairs: [], moves: [{ code: 'AMIRA (K)', size: 'K' }], fills: [], addSizes: ['K'], foldModels: ['AMIRA PREMUIM'],
  keptOff: true, leftInactive: 0, inactiveMoved: 0, totals: { pairs: 0, moves: 1, inactive: 0, folds: 1 }, confirm: 'MERGE 1 MODELS', ...over,
});
const open = () => {
  render(<QueryClientProvider client={new QueryClient()}><MergeModelsDialog codes={['AMIRA PREMIUM', 'AMIRA PREMUIM']} onClose={() => {}} /></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText('Type or pick the Model that stays'), { target: { value: 'AMIRA PREMIUM' } });
  fireEvent.change(screen.getByLabelText('Add a Model to merge'), { target: { value: 'AMIRA PREMUIM' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
};

describe('Merge models', () => {
  beforeEach(() => fetcher.mockReset());

  it('opens over the page, not inside the page header', () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MergeModelsButton codes={[]} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Merge models' }));
    expect(screen.getByPlaceholderText('Type or pick the Model that stays')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });

  it('merges only after a clean Check, sending back its phrase', async () => {
    fetcher.mockResolvedValueOnce(plan({}));
    fetcher.mockResolvedValueOnce({ merged: 'AMIRA PREMIUM', skuMerges: 0, moved: 1, folded: 1 });
    open();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Size K: AMIRA (K) moves under the kept Model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body as string)).toEqual({ keep: 'AMIRA PREMIUM', drops: ['AMIRA PREMUIM'], confirm: 'MERGE 1 MODELS' });
  });

  it('a refused Check leaves Merge off, and so does nothing to do', async () => {
    fetcher.mockResolvedValueOnce(plan({ refusals: ['different main suppliers'] }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Cannot merge: different main suppliers')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a Model that only holds switched-off codes can still be merged, and the Check says they move', async () => {
    fetcher.mockResolvedValueOnce(plan({ moves: [], addSizes: [], foldModels: [], keptOff: false, inactiveMoved: 4, totals: { pairs: 0, moves: 0, inactive: 4, folds: 0 } }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('4 switched-off SKU(s) move under the kept Model.')).toBeTruthy();
    expect(screen.queryByText(/Nothing to do/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

