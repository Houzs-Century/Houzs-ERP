/* 2026-10-26, HC-SO-2609-164: a Delivery Date picked from the calendar showed 28
   but the board saved nothing - the host compares its saved value with the
   picked one on blur, and the delayed blur after a pick ran the onBlur captured
   BEFORE the host re-rendered, i.e. with the old value. */
import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DateField } from './DateField';

function BlurCommitHost({ saved, onSave }: { saved: string; onSave: (v: string) => void }) {
  const [val, setVal] = useState(saved);
  return <DateField value={val} onChange={setVal} aria-label="Delivery date" onBlur={() => { if (val !== saved) onSave(val); }} />;
}

describe('DateField calendar pick', () => {
  test('a blur-committing host saves the PICKED date', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const { container } = render(<BlurCommitHost saved="2026-10-20" onSave={onSave} />);
    const native = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(native, { target: { value: '2026-10-28' } });
    vi.runAllTimers();
    vi.useRealTimers();
    expect(onSave).toHaveBeenCalledWith('2026-10-28');
  });
});
