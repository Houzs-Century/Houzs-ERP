/* The two things a phone needs from a date field, and the one thing every
   surface needs: a picker a finger can reach, and a refusal it can see.

   Owner, 2026-09-08, on his phone: 「我看我的 mobile version processing date
   delivery date 或者全部 date 为什么没有 dropdown calender 是要 manual type 的」.
   The picker was never missing — it was behind a 20px button with tabIndex -1,
   over a native input with pointer-events: none. Nothing on a touch screen
   could open it, so typing looked like the only way in. */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DateField, isCoarsePointer } from './DateField';

type Pointer = 'coarse' | 'fine';

/** jsdom ships no matchMedia at all, so the component reads a FINE pointer by
 *  default and every other test in the suite keeps the desktop behaviour. */
function setPointer(kind: Pointer) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('pointer: coarse') === (kind === 'coarse'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** jsdom implements no showPicker either; the component falls back to
 *  focus()+click() when it is absent, which is not what we are asserting. */
function stubShowPicker() {
  const spy = vi.fn();
  (HTMLInputElement.prototype as unknown as { showPicker: () => void }).showPicker = spy;
  return spy;
}

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  delete (HTMLInputElement.prototype as unknown as { showPicker?: unknown }).showPicker;
});

describe('reaching the picker by finger', () => {
  test('a tap on the text box opens the calendar on a coarse pointer', () => {
    setPointer('coarse');
    const showPicker = stubShowPicker();
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    fireEvent.click(screen.getByLabelText('Delivery date'));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  test('a mouse click on the same box does NOT open it — desktop typing is unchanged', () => {
    setPointer('fine');
    const showPicker = stubShowPicker();
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    fireEvent.click(screen.getByLabelText('Delivery date'));
    expect(showPicker).not.toHaveBeenCalled();
  });

  test('keyboard focus never opens the picker, on either pointer', () => {
    setPointer('coarse');
    const showPicker = stubShowPicker();
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    fireEvent.focus(screen.getByLabelText('Delivery date'));
    expect(showPicker).not.toHaveBeenCalled();
  });

  test('the calendar button still opens it, and a disabled field never does', () => {
    setPointer('fine');
    const showPicker = stubShowPicker();
    const { unmount } = render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(showPicker).toHaveBeenCalledTimes(1);
    unmount();

    setPointer('coarse');
    render(<DateField value="" onChange={() => {}} disabled aria-label="Locked date" />);
    fireEvent.click(screen.getByLabelText('Locked date'));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  test('isCoarsePointer is false where matchMedia does not exist', () => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    expect(isCoarsePointer()).toBe(false);
  });
});

describe('an unparseable draft is visible', () => {
  test('blur on text that does not parse says so instead of silently reverting', () => {
    const onChange = vi.fn();
    render(<DateField value="2026-09-01" onChange={onChange} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;

    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '7/9' } });
    fireEvent.blur(box);

    expect(box.value).toBe('7/9');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('dd/mm/yyyy');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a draft that parses commits and the field goes back to the canonical value', () => {
    const onChange = vi.fn();
    render(<DateField value="2026-09-01" onChange={onChange} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;

    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '7/9/2026' } });
    fireEvent.blur(box);

    expect(onChange).toHaveBeenLastCalledWith('2026-09-07');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  test('clearing the field is not an error', () => {
    const onChange = vi.fn();
    render(<DateField value="2026-09-01" onChange={onChange} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;

    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);

    expect(onChange).toHaveBeenLastCalledWith('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('re-focusing clears the flag and restores the canonical value', () => {
    render(<DateField value="2026-09-01" onChange={() => {}} aria-label="Invoice date" />);
    const box = screen.getByLabelText('Invoice date') as HTMLInputElement;

    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '99/99/9999' } });
    fireEvent.blur(box);
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.focus(box);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(box.value).toBe('01/09/2026');
  });
});
