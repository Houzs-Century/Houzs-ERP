/* The date mask (owner 2026-09-06: 日期我输入是我希望不用自己打 "/"). Pinned:
   digits typed straight through wear the DD/MM/YYYY mask as they land and
   reach the parent as ISO once complete; focus selects the pre-filled date so
   typing replaces it (the field arrived with today's date and typing used to
   APPEND, so nothing ever parsed); a two-digit year after separators reads
   as 20xx like the six-digit shortcut always did. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DateField, maskDmy, parseDmy } from './DateField';

describe('maskDmy', () => {
  test('grows the separators with the digits and stops at eight', () => {
    expect(maskDmy('')).toBe('');
    expect(maskDmy('3')).toBe('3');
    expect(maskDmy('31')).toBe('31');
    expect(maskDmy('310')).toBe('31/0');
    expect(maskDmy('3103')).toBe('31/03');
    expect(maskDmy('310320')).toBe('31/03/20');
    expect(maskDmy('31032026')).toBe('31/03/2026');
    expect(maskDmy('3103202699')).toBe('31/03/2026');
  });
});

describe('DateField typing', () => {
  test('digits wear the mask as they land and reach the parent as ISO when complete', () => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '3103' } });
    expect(box.value).toBe('31/03');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '31/032026' } });
    expect(box.value).toBe('31/03/2026');
    expect(onChange).toHaveBeenLastCalledWith('2026-03-31');
  });

  test('focus selects a pre-filled date so typing replaces it', () => {
    render(<DateField value="2026-09-06" onChange={() => {}} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;
    fireEvent.focus(box);
    expect(box.value).toBe('06/09/2026');
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]);
  });

  test('a two-digit year after separators reads as 20xx, as the six-digit shortcut does', () => {
    expect(parseDmy('31/03/26')).toBe('2026-03-31');
    expect(parseDmy('310326')).toBe('2026-03-31');
    expect(parseDmy('31/03/202')).toBeNull();
  });
});
