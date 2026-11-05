/* HC-0141: the Merge button stays off until a Check passes; the dialog says so
 * in words and shows which codes are kept / merged. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { MergeCodesDialog } from './MergeCodesDialog';

const plan = {
  pairs: [{ drop: 'ZZ9901-2S', keep: 'ZZ9901-1S', refusals: [], rekey: [], unitsMoved: 0, retire: true, dropStock: [] }],
  keepStock: [], totals: { pairs: 1, refused: 0, rowsToRekey: 0, unitsMoved: 0, toRetire: 1 }, confirm: 'MERGE 1', autoCount: [],
};
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn(async () => plan) }));

describe('MergeCodesDialog', () => {
  test('Merge is off until Check passes, and the dialog says why', async () => {
    render(<QueryClientProvider client={new QueryClient()}><MergeCodesDialog codes={['ZZ9901-1S', 'ZZ9901-2S']} onClose={() => {}} /></QueryClientProvider>);
    fireEvent.change(screen.getByPlaceholderText(/code that stays/i), { target: { value: 'ZZ9901-1S' } });
    fireEvent.change(screen.getByLabelText('Add a code to merge'), { target: { value: 'ZZ9901-2S' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/Keeping ZZ9901-1S, merging 1 code\(s\) into it\. Not checked yet\./)).toBeTruthy();
    expect(screen.getByText(/Press Check first/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Merge 0 code/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect((screen.getByRole('button', { name: /Merge 1 code/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/Check passed\./)).toBeTruthy();
  });
});
