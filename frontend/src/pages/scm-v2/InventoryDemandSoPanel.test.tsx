/* HC-0115: the Balances row expansion names the SOs behind Scheduled /
 * Unscheduled, each a link to the SO, so "Unscheduled 13" can be traced. */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DemandSoPanel } from './InventoryDemandSoPanel';

describe('DemandSoPanel', () => {
  it('lists each SO with customer, dates and qty, linked to the SO', () => {
    render(
      <MemoryRouter>
        <DemandSoPanel sos={[
          { doc_no: 'SO-037499', debtor_name: 'PRAVIN', so_date: '2026-08-01', delivery_date: '2026-10-20', qty: 2 },
          { doc_no: 'SO-037524', debtor_name: 'ONG', so_date: '2026-08-04', delivery_date: null, qty: 11 },
        ]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('SO-037524').closest('a')?.getAttribute('href')).toBe('/scm/sales-orders/SO-037524');
    expect(screen.getByText('↳ unscheduled')).toBeTruthy();
    expect(screen.getByText('↳ scheduled')).toBeTruthy();
    expect(screen.getByText(/ONG .* no delivery date/)).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
  });

  it('renders nothing when the SKU has no open SO demand', () => {
    const { container } = render(<MemoryRouter><DemandSoPanel sos={[]} /></MemoryRouter>);
    expect(container.innerHTML).toBe('');
  });
});
