/* THE DISCOUNT CELL MUST NOT BE TALLER THAN THE CELLS BESIDE IT.
 *
 * Owner, 2026-09-13, looking at a sales-order line: 「怎么不是整齐一点呢？」 —
 * the hint ("Set a unit price first", "= RM 250.00") rendered as a BLOCK under
 * the field, on every row, at rest. That made the Discount column about 14px
 * taller than Unit Price and Delivery Date beside it, so the whole line read
 * ragged, and on a phone it spent a permanent strip of the row on a sentence
 * nobody reads while scanning.
 *
 * The reading is worth having WHILE TYPING and worthless at rest, so it now
 * floats (absolute, out of flow) and is only visible while the field has focus.
 * At rest the same text is still on the input's `title`, and it is still
 * announced to a screen reader.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DiscountInput } from './DiscountInput';

afterEach(cleanup);

const mount = (props: Partial<Parameters<typeof DiscountInput>[0]> = {}) =>
  render(
    <DiscountInput
      valueSen={0}
      baseSen={0}
      currency="RM"
      onCommit={() => {}}
      {...props}
    />,
  );

const hintOf = (): HTMLElement => {
  const node = document.querySelector('[aria-live="polite"]');
  if (!node) throw new Error('the hint element is gone — the reading must still reach a screen reader');
  return node as HTMLElement;
};

describe('the discount hint does not make the row ragged', () => {
  it('is OUT OF FLOW, so the cell is the height of the input alone', () => {
    mount();
    expect(hintOf().style.position).toBe('absolute');
  });

  it('is invisible at rest', () => {
    mount({ baseSen: 0 });
    expect(hintOf().style.opacity).toBe('0');
  });

  it('appears when the operator starts typing in it, and goes again on blur', () => {
    mount({ baseSen: 100_00 });
    const input = screen.getByLabelText(/Discount/i);
    fireEvent.focus(input);
    expect(hintOf().style.opacity).toBe('1');
    fireEvent.blur(input);
    expect(hintOf().style.opacity).toBe('0');
  });

  it('still carries the reading at rest, on the title, so nothing is lost', () => {
    mount({ baseSen: 0 });
    expect(screen.getByLabelText(/Discount/i).getAttribute('title')).toMatch(/Set a unit price first/);
  });

  it('reads back a percentage as ringgit while it is being typed', () => {
    mount({ baseSen: 100_00 });
    const input = screen.getByLabelText(/Discount/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '25%' } });
    expect(hintOf().textContent).toContain('RM 25.00');
  });

  it('never wraps — a two-line hint would push the row down again', () => {
    mount({ baseSen: 100_00 });
    expect(hintOf().style.whiteSpace).toBe('nowrap');
  });

  it('does not swallow clicks meant for the row underneath it', () => {
    mount({ baseSen: 100_00 });
    expect(hintOf().style.pointerEvents).toBe('none');
  });
});
