/* DateField — the force-calendar rewrite.

   Owner 2026-09-10:
     * 「remove 掉可以打字 force 只能用 calender」
     * 「calender 点一下开点一下关 就这样简单」
     * 「全部 calender 也是全套系统」

   That supersedes the 2026-09-09 「可以保留手打」 split-field design (icon
   left = picker, text right = keyboard) whose 「有时能点到，有时点不到」 came
   from a 44px sub-region carrying the tap target. The new contract:

     * The text box is READ-ONLY on every pointer — no typing anywhere.
     * On a COARSE pointer the native <input type="date"> covers the WHOLE
       field via `.nativeIconTarget { inset: 0 }`, so a tap anywhere reaches
       a real, hit-testable date control and iOS raises its wheel with no
       script in the path.
     * On a FINE pointer the wrap's onClick opens the OS picker via
       showPicker() — so a mouse click ANYWHERE on the field opens the
       calendar, not only on the corner button.

   jsdom has no layout, so `inset: 0` cannot be measured here — what we pin
   is the render contract that geometry hangs off: the native input carries
   the touch-target class + attribute on coarse, the visible input is
   readOnly, and clicking the field reaches the picker. */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DateField, isCoarsePointer } from './DateField';

type Pointer = 'coarse' | 'fine';

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

function stubShowPicker() {
  const spy = vi.fn();
  (HTMLInputElement.prototype as unknown as { showPicker: () => void }).showPicker = spy;
  return spy;
}

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  delete (HTMLInputElement.prototype as unknown as { showPicker?: unknown }).showPicker;
});

function nativeDateInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[type="date"]');
  if (!el) throw new Error('no native date input rendered');
  return el as HTMLInputElement;
}

describe('DateField force-calendar contract', () => {
  test('coarse pointer: the native date input covers the field and takes the tap', () => {
    setPointer('coarse');
    const { container } = render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    const native = nativeDateInput(container);

    expect(native.dataset.touchTarget).toBe('true');
    expect(native.disabled).toBe(false);
    expect(native.className).toContain('nativeIconTarget');
    expect(native.className).not.toContain('nativeHidden');
    // Distinct accessible name from the visible text box so getByLabelText
    // stays unambiguous, and not aria-hidden (the input IS the affordance).
    expect(native.getAttribute('aria-hidden')).toBeNull();
    expect(native.getAttribute('aria-label')).toBe('Choose date');
  });

  test('fine pointer: the native input stays 20px behind the button', () => {
    setPointer('fine');
    const { container } = render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    const native = nativeDateInput(container);

    expect(native.dataset.touchTarget).toBeUndefined();
    expect(native.className).toContain('nativeHidden');
    expect(native.className).not.toContain('nativeIconTarget');
    expect(native.getAttribute('aria-hidden')).toBe('true');
  });

  test('no matchMedia falls back to the fine-pointer render', () => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    const { container } = render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    expect(nativeDateInput(container).dataset.touchTarget).toBeUndefined();
    expect(isCoarsePointer()).toBe(false);
  });

  test('the visible text box is READ-ONLY — no typing anywhere', () => {
    setPointer('fine');
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    const box = screen.getByLabelText('Delivery date') as HTMLInputElement;
    expect(box.type).toBe('text');
    expect(box.readOnly).toBe(true);
  });

  test('coarse: the text box is also read-only — no split-field keyboard', () => {
    setPointer('coarse');
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    const box = screen.getByLabelText('Delivery date') as HTMLInputElement;
    expect(box.readOnly).toBe(true);
  });

  test('fine pointer: a click ANYWHERE on the field opens the picker', () => {
    setPointer('fine');
    const showPicker = stubShowPicker();
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    // Clicking the visible text box bubbles to the wrap, which calls showPicker.
    fireEvent.click(screen.getByLabelText('Delivery date'));
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  test('fine pointer: the calendar button still opens the picker directly', () => {
    setPointer('fine');
    const showPicker = stubShowPicker();
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    // Button stops propagation; only one showPicker fires from the button path.
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  test('a calendar pick calls onChange with the ISO date + fires onBlur one tick later', async () => {
    setPointer('fine');
    const onChange = vi.fn();
    const onBlur = vi.fn();
    const { container } = render(
      <DateField value="" onChange={onChange} onBlur={onBlur} aria-label="Delivery date" />,
    );
    const native = nativeDateInput(container);
    fireEvent.change(native, { target: { value: '2026-09-07' } });
    expect(onChange).toHaveBeenCalledWith('2026-09-07');
    // onBlur fires on the next tick so a blur-committing host sees the change.
    await new Promise((r) => setTimeout(r, 0));
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  test('display formats the ISO value as DD/MM/YYYY, not the OS locale', () => {
    setPointer('fine');
    render(<DateField value="2026-09-07" onChange={() => {}} aria-label="Delivery date" />);
    const box = screen.getByLabelText('Delivery date') as HTMLInputElement;
    expect(box.value).toBe('07/09/2026');
  });

  test('disabled: no picker on click', () => {
    setPointer('fine');
    const showPicker = stubShowPicker();
    render(<DateField value="" onChange={() => {}} aria-label="Delivery date" disabled />);
    fireEvent.click(screen.getByLabelText('Delivery date'));
    expect(showPicker).not.toHaveBeenCalled();
  });
});
