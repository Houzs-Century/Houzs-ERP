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

/* ONE CHARACTER AT A TIME — the shape the tests above could not see.
   Every case here fires a change event per keystroke, the way a keyboard does.
   The three tests above fire WHOLE strings with padded two-digit components,
   and padded input re-lands on the mask's own slots, so `7/9/2026` losing its
   separators and arriving as `79/20/26` was invisible to them. */
describe('DateField typed one keystroke at a time', () => {
  const typeOut = (box: HTMLInputElement, text: string) => {
    for (const ch of text) fireEvent.change(box, { target: { value: box.value + ch } });
  };

  const typedResult = (text: string) => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;
    fireEvent.focus(box);
    typeOut(box, text);
    return { box, onChange };
  };

  test.each([
    ['7/9/2026', '2026-09-07'],
    ['1/1/2026', '2026-01-01'],
    ['7-9-2026', '2026-09-07'],
    ['31/3/2026', '2026-03-31'],
    ['7/9/26', '2026-09-07'],
  ])('the operator keeps his own separators: %s reaches the parent as %s', (typed, iso) => {
    const { box, onChange } = typedResult(typed);
    expect(box.value).toBe(typed);
    expect(onChange).toHaveBeenLastCalledWith(iso);
  });

  test.each([
    ['07092026', '07/09/2026', '2026-09-07'],
    ['31032026', '31/03/2026', '2026-03-31'],
    ['07/09/2026', '07/09/2026', '2026-09-07'],
    ['31/03/2026', '31/03/2026', '2026-03-31'],
  ])('regression cover — the padded forms still wear the mask: %s', (typed, shown, iso) => {
    const { box, onChange } = typedResult(typed);
    expect(box.value).toBe(shown);
    expect(onChange).toHaveBeenLastCalledWith(iso);
  });

  test('a half-typed date commits nothing and is reported on blur, not swallowed', () => {
    const { box, onChange } = typedResult('7/9');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(box.value).toBe('7/9');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });
});
