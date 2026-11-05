import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DateField } from './DateField';

function BlurCommitHost({ saved, onSave, onInvalid }: { saved: string; onSave: (v: string) => void; onInvalid?: (t: string) => void }) {
  const [val, setVal] = useState(saved);
  return <DateField value={val} onChange={setVal} aria-label="Delivery date" onBlur={() => { if (val !== saved) onSave(val); }} onInvalid={onInvalid} />;
}

/* HC-0164: HC-SO-006432's Delivery Date was set to 30/10, then saved as empty
   17 s later - clearing the box emitted '' and the retyped text did not parse,
   so the blur committed the ''. */
describe('DateField retype', () => {
  const retype = (saved: string, typed: string) => {
    const onSave = vi.fn();
    const onInvalid = vi.fn();
    const { getByLabelText } = render(<BlurCommitHost saved={saved} onSave={onSave} onInvalid={onInvalid} />);
    const box = getByLabelText('Delivery date') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(box, { target: { value: typed } });
    fireEvent.blur(box);
    return { onSave, onInvalid, box };
  };

  test('an unparseable retype saves nothing, says so and shows the saved date again', () => {
    const { onSave, onInvalid, box } = retype('2026-10-30', '30/13/2026');
    expect(onSave).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith('30/13/2026');
    expect(box.value).toBe('2026/10/30');
  });

  test('on an empty field the wrong text clears, nothing is saved', () => {
    const { onSave, onInvalid, box } = retype('', '31/02/2026');
    expect(onSave).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith('31/02/2026');
    expect(box.value).toBe('');
  });

  test('without onInvalid the wrong text stays on screen, outlined', () => {
    const onSave = vi.fn();
    const { getByLabelText } = render(<BlurCommitHost saved="2026-10-30" onSave={onSave} />);
    const box = getByLabelText('Delivery date') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.blur(box);
    expect(onSave).not.toHaveBeenCalled();
    expect(box.value).toBe('abc');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });

  test('a day-first date with the year last is read and saved', () => {
    const { onSave } = retype('2026-10-26', '30/10/2026');
    expect(onSave).toHaveBeenCalledWith('2026-10-30');
  });

  test('a box cleared on purpose still saves empty', () => {
    const { onSave } = retype('2026-10-30', '');
    expect(onSave).toHaveBeenCalledWith('');
  });
});
