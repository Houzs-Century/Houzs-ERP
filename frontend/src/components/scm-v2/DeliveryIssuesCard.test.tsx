import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The office create call is the one thing we stub — everything else (summary,
// serviceCaseHref) stays real.
const createServiceCaseForIssue = vi.fn(async (..._a: unknown[]) => ({ id: 77, assr_no: 'ASSR/2611-050' }));
vi.mock('../../vendor/scm/lib/delivery-issue-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createServiceCaseForIssue: (...a: unknown[]) => createServiceCaseForIssue(...a),
}));

import { DeliveryIssuesCard } from './DeliveryIssuesCard';
import type { DeliveryIssue } from '../../vendor/scm/lib/delivery-issue-queries';

afterEach(cleanup);

const base: DeliveryIssue = {
  id: 'i1', delivery_order_id: 'd1', do_number: 'HC-DO-000100', so_doc_no: 'HC-SO-000200',
  source_type: null, source_id: null, leg: null, kinds: ['damaged', 'wrong_item'], note: 'Leg cracked',
  photo_keys: ['slips/a', 'slips/b'], assr_case_id: null, assr_no: null, reported_by: 1, reported_at: '2026-11-09T02:00:00Z',
};

function renderCard(issues: DeliveryIssue[], canCreateCase: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><DeliveryIssuesCard showDo issues={issues} canCreateCase={canCreateCase} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DeliveryIssuesCard — the office sees what the crew reported', () => {
  it('shows the problems, the note, the DO and a link to a linked service case', () => {
    renderCard([{ ...base, assr_case_id: 77, assr_no: 'ASSR/2611-001' }], false);
    expect(screen.getByText('Delivered with issue')).toBeTruthy();
    expect(screen.getByText('Damaged, Wrong item or colour')).toBeTruthy();
    expect(screen.getByText('Leg cracked')).toBeTruthy();
    expect(screen.getByText(/HC-DO-000100/)).toBeTruthy();
    expect(screen.getByText(/2 photos/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Service case ASSR/2611-001' }).getAttribute('href')).toBe('/assr/77');
  });

  it('offers "Create service case" for an unlinked report and calls the office create', async () => {
    renderCard([base], true);
    const btn = screen.getByRole('button', { name: 'Create service case' });
    fireEvent.click(btn);
    await waitFor(() => expect(createServiceCaseForIssue).toHaveBeenCalledWith('i1'));
  });

  it('hides the create action from a user who cannot open cases', () => {
    renderCard([base], false);
    expect(screen.queryByRole('button', { name: 'Create service case' })).toBeNull();
    expect(screen.getByText('Service case not linked')).toBeTruthy();
  });

  it('renders nothing when there is no issue', () => {
    const { container } = renderCard([], true);
    expect(container.innerHTML).toBe('');
  });
});
