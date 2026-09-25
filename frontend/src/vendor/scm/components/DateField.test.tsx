/* DateField's typed entry. The display is always YYYY/MM/DD (owner 2026-09-25);
   what the owner TYPES may carry separators or none — 20260906 must land as
   2026-09-06. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DateField, parseDmy } from './DateField';

describe('parseDmy', () => {
  test('separators or none, year-first, 1-2 digit month/day', () => {
    expect(parseDmy('2026/09/06')).toBe('2026-09-06');
    expect(parseDmy('2026-9-6')).toBe('2026-09-06');
    expect(parseDmy('20260906')).toBe('2026-09-06');
    expect(parseDmy('2026/9/6')).toBe('2026-09-06');
  });

  test('a partial or impossible date is null, never a guess', () => {
    expect(parseDmy('2026090')).toBeNull();
    expect(parseDmy('20260231')).toBeNull();
    expect(parseDmy('2026/13/06')).toBeNull();
    expect(parseDmy('')).toBeNull();
  });
});

describe('DateField typing', () => {
  test('digits typed straight through reach the parent as ISO and snap to YYYY/MM/DD on blur', () => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} aria-label="Voucher date" />);
    const box = screen.getByLabelText('Voucher date') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '2026090' } });
    expect(onChange).not.toHaveBeenCalled(); // still typing
    fireEvent.change(box, { target: { value: '20260906' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-09-06');
  });
});
