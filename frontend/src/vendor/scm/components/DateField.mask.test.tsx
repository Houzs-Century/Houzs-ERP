/* The date mask (owner 2026-09-06: 日期我输入是我希望不用自己打 "/"; year-first
   YYYY/MM/DD since owner 2026-09-25). Pinned: digits typed straight through wear
   the mask as they land and reach the parent as ISO once complete; focus selects
   the pre-filled date so typing replaces it; the operator's own separators around
   an unpadded month/day survive (they are not the mask's slots). */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DateField, maskDmy, parseDmy } from './DateField';

describe('maskDmy (year-first)', () => {
  test('grows the separators with the digits and stops at eight', () => {
    expect(maskDmy('')).toBe('');
    expect(maskDmy('2')).toBe('2');
    expect(maskDmy('2026')).toBe('2026');
    expect(maskDmy('20260')).toBe('2026/0');
    expect(maskDmy('202603')).toBe('2026/03');
    expect(maskDmy('2026033')).toBe('2026/03/3');
    expect(maskDmy('20260331')).toBe('2026/03/31');
    expect(maskDmy('2026033199')).toBe('2026/03/31');
  });
});

describe('DateField typing', () => {
  test('digits wear the mask as they land and reach the parent as ISO when complete', () => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '202603' } });
    expect(box.value).toBe('2026/03');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '2026/0331' } });
    expect(box.value).toBe('2026/03/31');
    expect(onChange).toHaveBeenLastCalledWith('2026-03-31');
  });

  test('focus selects a pre-filled date so typing replaces it', () => {
    render(<DateField value="2026-09-06" onChange={() => {}} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;
    fireEvent.focus(box);
    expect(box.value).toBe('2026/09/06');
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, box.value.length]);
  });

  test('parses year-first with 1-2 digit month/day and rejects a bad month', () => {
    expect(parseDmy('2026/03/31')).toBe('2026-03-31');
    expect(parseDmy('20260331')).toBe('2026-03-31');
    expect(parseDmy('2026/3/1')).toBe('2026-03-01');
    expect(parseDmy('2026/13/01')).toBeNull();
    expect(parseDmy('2026/03/')).toBeNull();
  });
});

/* ONE CHARACTER AT A TIME — the shape whole-string tests could not see.
   Every case here fires a change event per keystroke, the way a keyboard does,
   so an unpadded month/day whose separators are the operator's own (`2026/9/7`)
   is exercised rather than the padded form that re-lands on the mask's slots. */
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
    ['2026/9/7', '2026-09-07'],
    ['2026/1/1', '2026-01-01'],
    ['2026-9-7', '2026-09-07'],
    ['2026/3/31', '2026-03-31'],
  ])('the operator keeps his own separators: %s reaches the parent as %s', (typed, iso) => {
    const { box, onChange } = typedResult(typed);
    expect(box.value).toBe(typed);
    expect(onChange).toHaveBeenLastCalledWith(iso);
  });

  test.each([
    ['20260907', '2026/09/07', '2026-09-07'],
    ['20260331', '2026/03/31', '2026-03-31'],
    ['2026/09/07', '2026/09/07', '2026-09-07'],
    ['2026/03/31', '2026/03/31', '2026-03-31'],
  ])('regression cover — the padded forms still wear the mask: %s', (typed, shown, iso) => {
    const { box, onChange } = typedResult(typed);
    expect(box.value).toBe(shown);
    expect(onChange).toHaveBeenLastCalledWith(iso);
  });

  test('a half-typed date commits nothing and is reported on blur, not swallowed', () => {
    const { box, onChange } = typedResult('2026/9');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(box.value).toBe('2026/9');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });
});
