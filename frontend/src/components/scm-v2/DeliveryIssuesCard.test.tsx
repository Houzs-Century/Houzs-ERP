import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryIssuesCard } from './DeliveryIssuesCard';

afterEach(cleanup);

describe('DeliveryIssuesCard — the office sees what the crew reported', () => {
  it('shows the problems, the note, the DO and a link to the service case', () => {
    render(<MemoryRouter><DeliveryIssuesCard showDo issues={[{
      id: 'i1', delivery_order_id: 'd1', do_number: 'HC-DO-000100', so_doc_no: 'HC-SO-000200', source_type: null, source_id: null, leg: null,
      kinds: ['damaged', 'wrong_item'], note: 'Leg cracked', photo_keys: ['slips/a', 'slips/b'], assr_case_id: 77, assr_no: 'ASSR/2611-001',
      reported_by: 1, reported_at: '2026-11-09T02:00:00Z',
    }]} /></MemoryRouter>);
    expect(screen.getByText('Delivered with issue')).toBeTruthy();
    expect(screen.getByText('Damaged, Wrong item or colour')).toBeTruthy();
    expect(screen.getByText('Leg cracked')).toBeTruthy();
    expect(screen.getByText(/HC-DO-000100/)).toBeTruthy();
    expect(screen.getByText(/2 photos on the case/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Service case ASSR/2611-001' }).getAttribute('href')).toBe('/assr/77');
  });
  it('renders nothing when there is no issue', () => {
    const { container } = render(<MemoryRouter><DeliveryIssuesCard issues={[]} /></MemoryRouter>);
    expect(container.innerHTML).toBe('');
  });
});
