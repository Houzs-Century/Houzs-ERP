/* Option C (owner, 2026-11-10): a SKU merge that leaves the dropped code's Model
 * with no active code folds that Model in the same Merge. Check says so before,
 * and the result says what happened - including a fold that was refused. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { MergeCodesDialog, foldLines } from './MergeCodesDialog';

const plan = {
  pairs: [{ drop: 'AMIRA PREMUIM (K)', keep: 'AMIRA PREMIUM (K)', refusals: [], rekey: [], unitsMoved: 0, retire: true, dropStock: [] }],
  keepStock: [], totals: { pairs: 1, refused: 0, rowsToRekey: 0, unitsMoved: 0, toRetire: 1 }, confirm: 'MERGE 1',
  modelFolds: [{ from: 'AMIRA PREMUIM', into: 'AMIRA PREMIUM', fold: true, codes: 4, reason: null }],
};
const applied = {
  merged: ['AMIRA PREMUIM (K)'], rekeyed: 0, problems: [],
  modelFolds: [{ from: 'AMIRA PREMUIM', into: 'AMIRA PREMIUM', fold: false, codes: 0, reason: 'a folded Model still carries sofa rows (sofa_quick_picks 1)' }],
};
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (url: string) => (url.endsWith('/apply') ? applied : plan)),
}));

describe('SKU merge folds the emptied Model', () => {
  test('Check shows the fold; the result reports a refused fold while the SKU merge stands', async () => {
    render(<QueryClientProvider client={new QueryClient()}><MergeCodesDialog codes={[]} onClose={() => {}} /></QueryClientProvider>);
    fireEvent.change(screen.getByPlaceholderText(/code that stays/i), { target: { value: 'AMIRA PREMIUM (K)' } });
    fireEvent.change(screen.getByLabelText('Add a code to merge'), { target: { value: 'AMIRA PREMUIM (K)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText('Model AMIRA PREMUIM will be merged into Model AMIRA PREMIUM (4 switched-off code(s) move with it).');
    fireEvent.click(screen.getByRole('button', { name: /Merge 1 code/ }));
    await waitFor(() => expect(screen.getByText('Merged 1 code(s) into AMIRA PREMIUM (K).')).toBeTruthy());
    expect(screen.getByText('Model AMIRA PREMUIM was not merged: a folded Model still carries sofa rows (sofa_quick_picks 1).')).toBeTruthy();
  });

  test('a Model that keeps an active code is named as staying', () => {
    expect(foldLines([{ from: 'X', into: 'Y', fold: false, codes: 0, reason: 'it still has 2 active code(s)' }], false))
      .toEqual(['Model X will not be merged: it still has 2 active code(s).']);
    expect(foldLines(undefined, true)).toEqual([]);
  });
});
