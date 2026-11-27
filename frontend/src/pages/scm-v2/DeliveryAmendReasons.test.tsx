/* The Amend Reasons editor (owner 2026-11-27): the list shows each reason as the
   customer will read it ("due to ...") and marks a hidden (inactive) one, so the
   owner sees exactly what goes out before picking it on the board. */
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../vendor/scm/lib/delivery-amend-reasons-queries', () => ({
  useDeliveryAmendReasons: () => ({
    data: [
      { id: '1', label: 'A public holiday falling on your delivery day', sortOrder: 80, isActive: true },
      { id: '2', label: 'Sudden mechanical breakdown of our delivery vehicle', sortOrder: 30, isActive: false },
    ],
    isLoading: false, isError: false,
  }),
  useCreateDeliveryAmendReason: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDeliveryAmendReason: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDeliveryAmendReason: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { DeliveryAmendReasons } from './DeliveryAmendReasons';

describe('DeliveryAmendReasons', () => {
  test('lists the managed reasons and flags a hidden one', () => {
    render(<DeliveryAmendReasons embedded />);
    expect(screen.getByText('A public holiday falling on your delivery day')).toBeTruthy();
    expect(screen.getByText('Sudden mechanical breakdown of our delivery vehicle')).toBeTruthy();
    expect(screen.getByText('Hidden')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Reason' })).toBeTruthy();
  });
});
