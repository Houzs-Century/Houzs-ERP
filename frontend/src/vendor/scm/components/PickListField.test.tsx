/* The supplier forms' payment terms and bank as pick lists (owner 2026-11-24:
   「这里有些应该是选的吧？例如term这些」). Pinned: a stored value on the list shows
   as its entry, in any case (the database keeps a bank upper case); one off the
   list opens the typed box with the value in it, never blanked; the free-text
   choice opens an empty box and an entry closes it; only a box marked `upper`
   shows upper case. */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PickListField } from './PickListField';
import { BANK_OTHER, MALAYSIAN_BANKS, PAYMENT_TERMS, PAYMENT_TERMS_CUSTOM } from '../../shared/pick-lists';

afterEach(() => cleanup());

const Bank = ({ initial, onChange = () => {} }: { initial: string; onChange?: (v: string) => void }) => {
  const [v, setV] = useState(initial);
  return (
    <PickListField label="Bank" options={MALAYSIAN_BANKS} other={BANK_OTHER} value={v}
      onChange={(next) => { setV(next); onChange(next); }}
      pickLabel="Pick the bank" typePlaceholder="The bank's name" upper classes={{}} />
  );
};
const select = () => screen.getByLabelText('Bank') as HTMLSelectElement;
const typed = () => screen.queryByLabelText('Bank (Other)') as HTMLInputElement | null;

describe('PickListField', () => {
  it('offers the list, an empty choice first and the free-text choice last', () => {
    render(<Bank initial="" />);
    const options = [...select().options].map((o) => o.value);
    expect(options).toEqual(['', ...MALAYSIAN_BANKS, BANK_OTHER]);
    expect(select().value).toBe('');
    expect(typed()).toBeNull();
  });

  it('shows a stored bank as its entry, whatever its case', () => {
    render(<Bank initial="HONG LEONG BANK" />);
    expect(select().value).toBe('Hong Leong Bank');
    expect(typed()).toBeNull();
  });

  it('opens a stored value the list does not have in the typed box, never blank', () => {
    render(<Bank initial="BANK OF CHINA" />);
    expect(select().value).toBe(BANK_OTHER);
    expect(typed()?.value).toBe('BANK OF CHINA');
  });

  it('the free-text choice opens an empty box to type in; an entry closes it', () => {
    const onChange = vi.fn();
    render(<Bank initial="Maybank" onChange={onChange} />);
    fireEvent.change(select(), { target: { value: BANK_OTHER } });
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(typed()?.value).toBe('');
    fireEvent.change(typed()!, { target: { value: 'Bank of China' } });
    expect(onChange).toHaveBeenLastCalledWith('Bank of China');
    fireEvent.change(select(), { target: { value: 'Public Bank' } });
    expect(onChange).toHaveBeenLastCalledWith('Public Bank');
    expect(typed()).toBeNull();
  });

  it('marks the typed box upper case only when asked', () => {
    render(<Bank initial="BANK OF CHINA" />);
    expect(typed()?.hasAttribute('data-upper')).toBe(true);
    cleanup();
    render(<PickListField label="Payment terms" options={PAYMENT_TERMS} other={PAYMENT_TERMS_CUSTOM} value="45 days after delivery"
      onChange={() => {}} pickLabel="Pick the term" typePlaceholder="Type the term" upper={false} classes={{}} />);
    expect((screen.getByLabelText('Payment terms') as HTMLSelectElement).value).toBe(PAYMENT_TERMS_CUSTOM);
    const box = screen.getByLabelText('Payment terms (Custom)') as HTMLInputElement;
    expect(box.value).toBe('45 days after delivery');
    expect(box.hasAttribute('data-upper')).toBe(false);
  });
});
