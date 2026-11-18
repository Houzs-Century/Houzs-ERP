import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SoAddressLines } from './SoAddressLines';

/* Owner 2026-11-18: every address form shows two lines, then Postcode / City /
   State. A sales order still stores four (the account book's columns), so line 2
   shows lines 3 / 4 and editing it clears them — nothing stored is hidden. */
const TOWN = { postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' };
const view = (lines: [string, string, string, string], onChange = vi.fn()) => {
  render(<SoAddressLines lines={lines} town={TOWN} onChange={onChange}
    fieldClassName="f" labelClassName="l" inputClassName={() => 'i'} />);
  return onChange;
};

describe('SoAddressLines', () => {
  test('two inputs, never a line 3 or 4', () => {
    view(['TREED SUNGAI ARA', '', '', '']);
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.queryByText('Address Line 3')).toBeNull();
    expect(screen.queryByText('Address Line 4')).toBeNull();
  });

  test('line 2 shows what lines 3 / 4 hold, except a line repeating the postcode / city / state', () => {
    view(['TREED SUNGAI ARA', 'Jalan Satu', 'Taman Dua', '11900 Bayan Lepas']);
    const [, line2] = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(line2.value).toBe('Jalan Satu, Taman Dua');
  });

  test('editing line 2 writes it to line 2 and clears lines 3 / 4', () => {
    const onChange = view(['A', 'Jalan Satu', 'Taman Dua', '']);
    const [, line2] = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(line2, { target: { value: 'Jalan Satu, Taman Tiga' } });
    expect(onChange.mock.calls).toEqual([[2, 'Jalan Satu, Taman Tiga'], [3, ''], [4, '']]);
  });

  test('with nothing in lines 3 / 4, typing only touches line 2', () => {
    const onChange = view(['A', 'Jalan', '', '']);
    const [, line2] = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(line2, { target: { value: 'Jalan ' } });
    expect(onChange.mock.calls).toEqual([[2, 'Jalan ']]);
  });
});
