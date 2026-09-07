/* DateField's typed entry. The display is always DD/MM/YYYY; what the owner
   TYPES may carry separators or none — 06092026 must land as 2026-09-06
   (2026-09-06: 日期那边我要输入时会变这样, the field had refused it). */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DateField, parseDmy } from './DateField';

describe('parseDmy', () => {
  test('separators or none, day-first, two- or four-digit year', () => {
    expect(parseDmy('06/09/2026')).toBe('2026-09-06');
    expect(parseDmy('6-9-2026')).toBe('2026-09-06');
    expect(parseDmy('06092026')).toBe('2026-09-06');
    expect(parseDmy('060926')).toBe('2026-09-06');
  });

  test('a partial or impossible date is null, never a guess', () => {
    expect(parseDmy('0609202')).toBeNull();
    expect(parseDmy('31022026')).toBeNull();
    expect(parseDmy('06/13/2026')).toBeNull();
    expect(parseDmy('')).toBeNull();
  });
});

describe('DateField typing', () => {
  test('digits typed straight through reach the parent as ISO and snap to DD/MM/YYYY on blur', () => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} aria-label="Voucher date" />);
    const box = screen.getByLabelText('Voucher date') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '0609202' } });
    expect(onChange).not.toHaveBeenCalled(); // still typing
    fireEvent.change(box, { target: { value: '06092026' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-09-06');
  });
});
