import { describe, expect, test } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADDRESS_LINE_MAX, addressLineProps } from './acColumnWidths';

function AddressPair() {
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  return (
    <>
      <input aria-label="Address Line 1" value={line1}
        {...addressLineProps(setLine1, { value: line2, set: setLine2 })}
        onChange={(e) => setLine1(e.target.value)} />
      <input aria-label="Address Line 2" value={line2}
        {...addressLineProps(setLine2, null)}
        onChange={(e) => setLine2(e.target.value)} />
    </>
  );
}

const line1 = () => screen.getByLabelText('Address Line 1') as HTMLInputElement;
const line2 = () => screen.getByLabelText('Address Line 2') as HTMLInputElement;

describe('the address box, as a person meets it', () => {
  test('both boxes carry the account book\'s width as a real attribute', () => {
    render(<AddressPair />);
    expect(line1().maxLength).toBe(ADDRESS_LINE_MAX);
    expect(line2().maxLength).toBe(ADDRESS_LINE_MAX);
  });

  test('typing STOPS at the limit — the 41st character does not land', async () => {
    const user = userEvent.setup();
    render(<AddressPair />);
    const typed = 'No 12 Jalan Perindustrian Bukit Minyak 2 Taman';
    expect(typed.length).toBeGreaterThan(ADDRESS_LINE_MAX);
    await user.type(line1(), typed);
    expect(line1().value).toHaveLength(ADDRESS_LINE_MAX);
    expect(line1().value).toBe(typed.slice(0, ADDRESS_LINE_MAX));
  });

  test('pasting a long address continues on line 2, losing no word', async () => {
    const user = userEvent.setup();
    render(<AddressPair />);
    const pasted = 'No 12 Jalan Perindustrian Bukit Minyak 2 Taman Perindustrian Bukit Minyak';
    line1().focus();
    await user.paste(pasted);
    expect(line1().value.length).toBeLessThanOrEqual(ADDRESS_LINE_MAX);
    expect(`${line1().value} ${line2().value}`).toBe(pasted);
  });

  test('the LAST box keeps an over-long paste rather than cutting it', async () => {
    const user = userEvent.setup();
    render(<AddressPair />);
    const pasted = 'Kawasan Perindustrian Bukit Minyak Seberang Perai Tengah';
    line2().focus();
    await user.paste(pasted);
    expect(line2().value).toBe(pasted);
  });
});
