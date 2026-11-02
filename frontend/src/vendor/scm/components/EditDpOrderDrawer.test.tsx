/* Edit a pending DP order (owner 2026-11-02, "DP order maintenance"). Pinned:
   the drawer prefills from the row; Save sends EVERY field (a cleared one as
   null, so an address line typed in error can be removed); and Save is blocked
   when no address line is left — the one rule the backend also enforces. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const mutate = vi.hoisted(() => vi.fn());

vi.mock('../lib/delivery-planning-queries', () => ({
  useUpdateDpOrder: () => ({ mutate, isPending: false }),
  dpJobTypeLabel: (v: string) => v,
}));
vi.mock('./NotifyDialog', () => ({ useNotify: () => () => {} }));
vi.mock('../lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

const { EditDpOrderDrawer } = await import('./EditDpOrderDrawer');

// The DpOrderRow fields the drawer reads (the rest are irrelevant to it).
const row = {
  id: 'dp-7',
  dp_no: null,
  job_type: 'TRANSFER',
  party_name: 'MSJ TRANSPORT SDN BHD',
  contact_name: 'Rahman',
  contact_phone: '0127778888',
  address1: 'No 3, Jalan Perdagangan',
  address2: '',
  address3: '',
  address4: '',
  city: 'Johor Bahru',
  postcode: '81100',
  state: 'Johor',
  // Origin ("from") — a transfer carries one (owner 2026-11-02 方案1).
  from_name: 'KL Warehouse',
  from_address1: 'Lot 12, Jalan Balakong',
  from_address2: '',
  from_city: 'Seri Kembangan',
  from_postcode: '43300',
  from_state: 'Selangor',
  requested_date: '2026-11-05',
  remark: '',
} as unknown as Parameters<typeof EditDpOrderDrawer>[0]['row'];

const saveBtn = () => screen.getByText('Save changes').closest('button') as HTMLButtonElement;

describe('EditDpOrderDrawer', () => {
  test('prefills the stored fields, origin included', () => {
    render(<EditDpOrderDrawer row={row} onClose={() => {}} />);
    expect(screen.getByDisplayValue('MSJ TRANSPORT SDN BHD')).toBeTruthy();
    expect(screen.getByDisplayValue('No 3, Jalan Perdagangan')).toBeTruthy();
    expect(screen.getByDisplayValue('Johor Bahru')).toBeTruthy();
    // Origin ("from") section prefilled too.
    expect(screen.getByDisplayValue('KL Warehouse')).toBeTruthy();
    expect(screen.getByDisplayValue('Lot 12, Jalan Balakong')).toBeTruthy();
  });

  test('Save sends every field, a cleared one as null', () => {
    mutate.mockClear();
    render(<EditDpOrderDrawer row={row} onClose={() => {}} />);
    // Correct the party name; clear the remark stays empty -> null.
    fireEvent.change(screen.getByDisplayValue('MSJ TRANSPORT SDN BHD'), { target: { value: '  MSJ Transport  ' } });
    fireEvent.click(saveBtn());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      id: 'dp-7',
      partyName: 'MSJ Transport',
      contactName: 'Rahman',
      contactPhone: '0127778888',
      address1: 'No 3, Jalan Perdagangan',
      address2: null,
      address3: null,
      address4: null,
      city: 'Johor Bahru',
      postcode: '81100',
      state: 'Johor',
      // Origin ("from") rides along for a transfer.
      fromName: 'KL Warehouse',
      fromAddress1: 'Lot 12, Jalan Balakong',
      fromAddress2: null,
      fromCity: 'Seri Kembangan',
      fromPostcode: '43300',
      fromState: 'Selangor',
      requestedDate: '2026-11-05',
      remark: null,
    });
  });

  test('a non-transfer job carries no origin fields in the patch', () => {
    mutate.mockClear();
    const setupRow = { ...row, job_type: 'SETUP' } as unknown as Parameters<typeof EditDpOrderDrawer>[0]['row'];
    render(<EditDpOrderDrawer row={setupRow} onClose={() => {}} />);
    // The From section is absent, so its fields never reach the patch.
    expect(screen.queryByText('From (origin)')).toBeNull();
    fireEvent.click(saveBtn());
    const sent = mutate.mock.calls[0][0] as Record<string, unknown>;
    expect('fromName' in sent).toBe(false);
    expect('fromAddress1' in sent).toBe(false);
  });

  test('Save is blocked once the last address line is cleared', () => {
    render(<EditDpOrderDrawer row={row} onClose={() => {}} />);
    expect(saveBtn().disabled).toBe(false);
    fireEvent.change(screen.getByDisplayValue('No 3, Jalan Perdagangan'), { target: { value: '   ' } });
    expect(saveBtn().disabled).toBe(true);
  });
});
