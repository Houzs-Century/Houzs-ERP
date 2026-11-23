/* A consignment return line must come from a Consignment Note line (owner 23 Nov 2026; server 409
   note_link_required). The blank form offers no free "Add line" and steers to the From-Note picker; a return
   opened from a note carries each line's note-line id to the server (it used to send none, so even a
   note-started return was free-entry). */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
const notify = vi.fn();
vi.mock('../../vendor/scm/lib/consignment-return-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/consignment-return-queries')>()),
  useCreateConsignmentReturn: () => ({ mutate, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/consignment-note-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/consignment-note-queries')>()),
  useConsignmentNoteDetail: (id: string | null) => (id
    ? {
        data: {
          deliveryOrder: { id: 'cn-1', do_number: 'HC-CN-2610-001', debtor_name: 'Showroom A' },
          items: [{ id: 'ni-1', item_code: 'DIVAN ONLY-(K)', item_group: 'bedframe', description: 'Divan', uom: 'UNIT', qty: 1, unit_price_sen: 0, discount_sen: 0, unit_cost_sen: 0, variants: {} }],
        },
        isLoading: false,
      }
    : { data: undefined, isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/admin-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/admin-queries')>()),
  usePickableStaff: () => ({ data: [] }),
}));
vi.mock('../../vendor/scm/lib/localities-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/localities-queries')>()),
  useLocalities: () => ({ data: [] }),
}));
vi.mock('../../vendor/scm/lib/so-dropdown-options-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/so-dropdown-options-queries')>()),
  useSoDropdownOptions: () => ({ data: [] }),
}));
vi.mock('../../vendor/scm/components/NotifyDialog', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => notify,
}));

vi.mock('../../auth/AuthContext', async (orig) => ({
  ...(await orig<typeof import('../../auth/AuthContext')>()),
  useAuth: () => ({ user: { id: 1 }, can: () => true }),
}));

import { ConsignmentReturnNew } from './ConsignmentReturnNew';

const renderAt = (url: string) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[url]}><ConsignmentReturnNew /></MemoryRouter>
  </QueryClientProvider>,
);

afterEach(() => { cleanup(); mutate.mockReset(); notify.mockReset(); });

describe('New Consignment Return needs a Consignment Note', () => {
  it('the blank form has no free "Add line" and points to the note picker', () => {
    renderAt('/scm/consignment-returns/new');
    expect(screen.getByText(/Every return line must be picked from a Consignment Note/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add line/i })).toBeNull();
  });

  it('a return opened from a note sends each line with its note-line id', () => {
    renderAt('/scm/consignment-returns/new?fromConsignmentNote=cn-1');
    fireEvent.click(screen.getByRole('button', { name: /Create Consignment Return/ }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0]![0] as { items: Array<{ consignmentDoItemId?: string }> };
    expect(body.items.map((i) => i.consignmentDoItemId)).toEqual(['ni-1']);
  });
});
