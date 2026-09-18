/* SearchCombo by keyboard (owner 2026-09-06: SUPPLIER 选的时候我希望可以按往下
   选). ↓ moved the highlight but the panel never scrolled with it, so past
   the seventh row the key looked dead. Pinned: the highlighted option is
   scrolled into view as ↓ moves; a closed panel opens ON the first option;
   Enter picks the highlighted one. */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SearchCombo, type ComboOption } from './SearchCombo';

const OPTIONS: ComboOption[] = Array.from({ length: 30 }, (_, i) => ({
  value: `sup-${i + 1}`,
  label: `405-H${String(i + 1).padStart(3, '0')} · SUPPLIER ${i + 1}`,
}));

afterEach(() => { vi.restoreAllMocks(); });

describe('SearchCombo keyboard', () => {
  test('↓ steps the highlight and scrolls it into view; Enter picks it', () => {
    const scrolled: HTMLElement[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true, writable: true,
      value: function (this: HTMLElement) { scrolled.push(this); },
    });
    const onChange = vi.fn();
    render(<SearchCombo options={OPTIONS} value="" onChange={onChange} aria-label="Supplier" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[3]!.style.background).toContain('cream');
    expect(scrolled[scrolled.length - 1]).toBe(options[3]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('sup-4');
  });

  test('a closed panel opens ON the first option, not past it', () => {
    const onChange = vi.fn();
    render(<SearchCombo options={OPTIONS} value="" onChange={onChange} aria-label="Supplier" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[0]!.style.background).toContain('cream');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('sup-1');
  });
});
