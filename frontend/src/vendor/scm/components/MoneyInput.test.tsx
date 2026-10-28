/* MoneyInput at rest and under the caret (owner 2026-09-06: amount 这边我希望
   显示千位数,和哪怕没有分都要显示 .00). Pinned: at rest the amount reads
   1,800.00 / 3.56 / 0.00; focus shows the plain form so the caret meets no
   comma; a typed comma is tolerated; blur commits sen and re-dresses. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MoneyInput, fmtMoneyAtRest } from './MoneyInput';

describe('fmtMoneyAtRest', () => {
  test('thousands separated, always two decimals', () => {
    expect(fmtMoneyAtRest(180_000)).toBe('1,800.00');
    expect(fmtMoneyAtRest(356)).toBe('3.56');
    expect(fmtMoneyAtRest(0)).toBe('0.00');
    expect(fmtMoneyAtRest(214_374)).toBe('2,143.74');
    expect(fmtMoneyAtRest(null)).toBe('');
  });
});

describe('MoneyInput', () => {
  test('rests dressed, edits plain, commits sen and re-dresses on blur', () => {
    const onCommit = vi.fn();
    render(<MoneyInput bare valueSen={180_000} onCommit={onCommit} aria-label="line 1 amount" />);
    const box = screen.getByLabelText('line 1 amount') as HTMLInputElement;
    expect(box.value).toBe('1,800.00');
    fireEvent.focus(box);
    expect(box.value).toBe('1800.00');
    fireEvent.change(box, { target: { value: '2,143.74' } });
    expect(box.value).toBe('2143.74');
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(214_374);
    expect(box.value).toBe('2,143.74');
  });

  test('a whole number gains its .00; Enter commits like blur', () => {
    const onCommit = vi.fn();
    render(<MoneyInput bare valueSen={0} onCommit={onCommit} aria-label="amount" />);
    const box = screen.getByLabelText('amount') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '75' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(7_500);
    expect(box.value).toBe('75.00');
  });
});
