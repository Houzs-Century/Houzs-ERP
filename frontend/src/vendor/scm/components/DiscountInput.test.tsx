/* DiscountInput — RM/% toggle. Owner rule (2026-09-11): the percentage is
   NOT stored; the commit is always the resolved sen amount. These pin that
   the % path resolves against baseSen the same way an operator would with
   a calculator, and that switching modes preserves the sen value. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DiscountInput } from './DiscountInput';

const RM_LABEL = 'Discount unit: RM — click to switch';
const PCT_LABEL = 'Discount unit: % — click to switch';

describe('DiscountInput — RM mode', () => {
  test('defaults to RM and commits sen on blur, like MoneyInput', () => {
    const onCommit = vi.fn();
    render(
      <DiscountInput bare valueSen={0} baseSen={1_000_00} onCommit={onCommit} />,
    );
    expect(screen.getByRole('button', { name: RM_LABEL })).toBeTruthy();
    const box = screen.getByTitle(/Click to edit/) as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '250' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(25_000);
  });
});

describe('DiscountInput — % mode', () => {
  test('toggle to %, type 25, commits Math.round(baseSen * 25 / 100)', () => {
    const onCommit = vi.fn();
    render(
      <DiscountInput bare valueSen={0} baseSen={1_000_00} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: RM_LABEL }));
    const box = screen.getByLabelText('Discount percentage') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '25' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(25_000);
  });

  test('a non-integer percentage rounds to the nearest sen', () => {
    const onCommit = vi.fn();
    render(
      <DiscountInput bare valueSen={0} baseSen={333_33} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: RM_LABEL }));
    const box = screen.getByLabelText('Discount percentage') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '12.5' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(4_167); // 333.33 * 12.5% = 41.66625 -> 41.67 RM -> 4167 sen
  });

  test('a percentage above 100 clamps to 100', () => {
    const onCommit = vi.fn();
    render(
      <DiscountInput bare valueSen={0} baseSen={1_000_00} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: RM_LABEL }));
    const box = screen.getByLabelText('Discount percentage') as HTMLInputElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '150' } });
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(100_000);
  });

  test('mode-switch back to RM reads the current sen amount', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <DiscountInput bare valueSen={25_000} baseSen={1_000_00} onCommit={onCommit} />,
    );
    // In RM (default) the field carries the sen amount, dressed.
    expect((screen.getByTitle(/Click to edit/) as HTMLInputElement).value).toBe('250.00');
    // Toggle to %; the field derives 25.00% from 25000 / 100000.
    fireEvent.click(screen.getByRole('button', { name: RM_LABEL }));
    expect((screen.getByLabelText('Discount percentage') as HTMLInputElement).value).toBe('25');
    // Toggle back to RM without touching anything — the sen value survived.
    fireEvent.click(screen.getByRole('button', { name: PCT_LABEL }));
    rerender(<DiscountInput bare valueSen={25_000} baseSen={1_000_00} onCommit={onCommit} />);
    expect((screen.getByTitle(/Click to edit/) as HTMLInputElement).value).toBe('250.00');
  });
});

describe('DiscountInput — edge cases', () => {
  test('baseSen === 0 disables the % field but still allows toggling back to RM', () => {
    const onCommit = vi.fn();
    render(
      <DiscountInput bare valueSen={0} baseSen={0} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: RM_LABEL }));
    const box = screen.getByLabelText('Discount percentage') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    // The toggle stays enabled so the user isn't trapped.
    expect(screen.getByRole('button', { name: PCT_LABEL }).hasAttribute('disabled')).toBe(false);
  });
});
