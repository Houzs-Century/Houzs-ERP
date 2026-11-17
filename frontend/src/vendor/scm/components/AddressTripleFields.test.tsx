/* Owner 2026-11-17: every Delivery Planning job carries Postcode + City + State,
 * taken from the masters (warehouse, 3PL company, venue). Their forms now use
 * the Sales Order's controls — and the point of those is that a Postcode picked
 * first fills City and State back. This pins that cascade through the shared
 * trio every one of those forms renders. */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const ROWS = [
  { postcode: '47500', city: 'Subang Jaya', state: 'Selangor', stateCode: 'SGR', country: 'Malaysia' },
  { postcode: '10050', city: 'George Town', state: 'Pulau Pinang', stateCode: 'PNG', country: 'Malaysia' },
];
vi.mock('../lib/localities-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/localities-queries')>()),
  useLocalities: () => ({ data: ROWS, isLoading: false }),
}));

import { AddressTripleFields } from './AddressTripleFields';

const Host = ({ onChange }: { onChange: (v: unknown) => void }) => {
  const [v, setV] = useState({ state: '', city: '', postcode: '' });
  return (
    <AddressTripleFields
      country=""
      value={v}
      onChange={(next, country) => { setV(next); onChange({ ...next, country }); }}
    />
  );
};

describe('AddressTripleFields — the Sales Order cascade on a master form', () => {
  it('a postcode picked first fills City and State back, with the Country of that State', () => {
    const seen = vi.fn();
    render(<Host onChange={seen} />);
    const postcode = screen.getByPlaceholderText('Pick postcode — State and City fill in');
    fireEvent.focus(postcode);
    fireEvent.change(postcode, { target: { value: '47500' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: '47500' }));
    expect(seen).toHaveBeenLastCalledWith({ state: 'Selangor', city: 'Subang Jaya', postcode: '47500', country: 'Malaysia' });
    expect((screen.getByRole('combobox', { name: 'City' }) as HTMLInputElement).value).toBe('Subang Jaya');
  });

  it('the postcode is offered with no State picked — any field can start the cascade', () => {
    render(<Host onChange={() => {}} />);
    const postcode = screen.getByPlaceholderText('Pick postcode — State and City fill in');
    fireEvent.focus(postcode);
    expect(screen.getByRole('option', { name: '10050' })).toBeTruthy();
  });

  it('the pickers do not invite the browser address autofill', () => {
    render(<Host onChange={() => {}} />);
    expect(screen.getByPlaceholderText('Pick postcode — State and City fill in').getAttribute('autocomplete')).toBe('off');
  });
});
