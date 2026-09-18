/* DiscountInput — ONE field, typed. Owner 2026-09-12: 「就是 1000 / 25% 这样不
   需要特别去选」. The RM/% toggle (2026-09-11, docs/bugs/0803) is gone; what was
   typed decides which unit it was. The commit is ALWAYS the resolved sen amount
   — no percentage is persisted (owner ruling 2026-09-11, unchanged).

   The decision itself is `readDiscountEntry`, tested directly: "amount or
   percentage" is the feature, and a decision reachable only through a rendered
   input is one nobody can enumerate the cases of. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DiscountInput, readDiscountEntry } from './DiscountInput';

const BASE = 1_000_00; // RM 1,000.00 line, so 25% is RM 250.00

describe('readDiscountEntry — what did the operator mean', () => {
  test('a bare number is an AMOUNT in ringgit', () => {
    expect(readDiscountEntry('1000', BASE)).toEqual({ kind: 'amount', sen: 100_000 });
    expect(readDiscountEntry('12.50', BASE)).toEqual({ kind: 'amount', sen: 1_250 });
  });

  test('a trailing % is a PERCENTAGE, resolved against the line base', () => {
    expect(readDiscountEntry('25%', BASE)).toEqual({ kind: 'percent', pct: 25, sen: 25_000 });
    expect(readDiscountEntry('12.5 %', BASE)).toEqual({ kind: 'percent', pct: 12.5, sen: 12_500 });
  });

  test('a pasted amount keeps its currency word', () => {
    expect(readDiscountEntry('RM 1,000', BASE)).toEqual({ kind: 'amount', sen: 100_000 });
    expect(readDiscountEntry('myr250.00', BASE)).toEqual({ kind: 'amount', sen: 25_000 });
  });

  test('over 100% is clamped to the whole line, never more', () => {
    expect(readDiscountEntry('120%', BASE)).toEqual({ kind: 'percent', pct: 100, sen: BASE });
  });

  test('a percentage with no base is INVALID, not a silent zero', () => {
    expect(readDiscountEntry('25%', 0)).toEqual({ kind: 'invalid' });
  });

  test('blank clears; a typo commits nothing', () => {
    expect(readDiscountEntry('   ', BASE)).toEqual({ kind: 'blank' });
    expect(readDiscountEntry('abc', BASE)).toEqual({ kind: 'invalid' });
    expect(readDiscountEntry('25%%', BASE)).toEqual({ kind: 'invalid' });
  });
});

describe('DiscountInput — one field, no mode to pick', () => {
  test('there is no RM/% toggle any more', () => {
    render(<DiscountInput bare valueSen={0} baseSen={BASE} onCommit={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('typing an amount commits sen', () => {
    const onCommit = vi.fn();
    render(<DiscountInput bare valueSen={0} baseSen={BASE} onCommit={onCommit} />);
    const box = screen.getByLabelText('Discount — type an amount or a percentage');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '250' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(25_000);
  });

  test('typing 25% commits the resolved ringgit, not the percentage', () => {
    const onCommit = vi.fn();
    render(<DiscountInput bare valueSen={0} baseSen={BASE} onCommit={onCommit} />);
    const box = screen.getByLabelText('Discount — type an amount or a percentage');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '25%' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(25_000);
  });

  test('the hint shows the OTHER unit while typing a percentage', () => {
    render(<DiscountInput bare valueSen={0} baseSen={BASE} onCommit={vi.fn()} />);
    const box = screen.getByLabelText('Discount — type an amount or a percentage');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '25%' } });
    expect(screen.getByText('= RM 250.00')).toBeTruthy();
  });

  test('a stored amount reads back as an amount, with its percentage in the hint', () => {
    render(<DiscountInput bare valueSen={25_000} baseSen={BASE} onCommit={vi.fn()} />);
    const box = screen.getByLabelText('Discount — type an amount or a percentage') as HTMLInputElement;
    expect(box.value).toBe('250.00');
    expect(screen.getByText('= 25% of RM 1000.00')).toBeTruthy();
  });

  test('clearing the field commits 0', () => {
    const onCommit = vi.fn();
    render(<DiscountInput bare valueSen={25_000} baseSen={BASE} onCommit={onCommit} />);
    const box = screen.getByLabelText('Discount — type an amount or a percentage');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  test('a typo reverts to the stored value and commits nothing', () => {
    const onCommit = vi.fn();
    render(<DiscountInput bare valueSen={25_000} baseSen={BASE} onCommit={onCommit} />);
    const box = screen.getByLabelText('Discount — type an amount or a percentage') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    expect(box.value).toBe('250.00');
  });
});
