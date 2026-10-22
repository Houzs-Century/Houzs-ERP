/* Print now / View full PDF. Pinned: both open the in-app viewer (no window.open —
   it would run after the render await and be blocked as a popup); 'print' asks
   the viewer for the dialog once it has loaded (after a settle) and the Print
   button asks again; 'preview' never asks; Esc closes only the viewer; the
   viewer's New tab is the one route that still opens a tab. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverPdfBlob } from './pdf-common';

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:http://erp/abc';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  openSpy.mockRestore();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

const pdf = () => new Blob(['%PDF'], { type: 'application/pdf' });
const viewer = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const buttonNamed = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const stubFrame = (print: () => void) => {
  const frame = document.body.querySelector('iframe') as HTMLIFrameElement;
  Object.defineProperty(frame, 'contentWindow', { value: { print, focus: vi.fn() }, configurable: true });
  return frame;
};

describe('the in-app PDF viewer', () => {
  it("'print' shows the PDF in the ERP and asks for the dialog once the viewer loaded", () => {
    deliverPdfBlob(pdf(), 'payment-corrections-2026-09.pdf', 'print');
    expect(openSpy).not.toHaveBeenCalled();
    expect(viewer()?.getAttribute('aria-label')).toBe('payment-corrections-2026-09');
    const print = vi.fn();
    const frame = stubFrame(print);
    expect(frame.getAttribute('src')).toBe('blob:http://erp/abc');
    expect(frame.style.width).toBe('100%');

    frame.dispatchEvent(new Event('load'));
    expect(print).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(print).toHaveBeenCalledTimes(1);
    buttonNamed('Print').click();
    expect(print).toHaveBeenCalledTimes(2);
  });

  it('a viewer that refuses does not throw out of the overlay', () => {
    deliverPdfBlob(pdf(), 'x.pdf', 'print');
    const frame = stubFrame(() => { throw new Error('not ready'); });
    frame.dispatchEvent(new Event('load'));
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
  });

  it("'preview' opens the same viewer without asking for the dialog", () => {
    deliverPdfBlob(pdf(), 'x.pdf', 'preview');
    expect(openSpy).not.toHaveBeenCalled();
    const print = vi.fn();
    stubFrame(print).dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(1000);
    expect(print).not.toHaveBeenCalled();
  });

  it('Esc closes only the viewer and restores page scroll', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    deliverPdfBlob(pdf(), 'x.pdf', 'preview');
    expect(document.body.style.overflow).toBe('hidden');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(viewer()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('');
    document.removeEventListener('keydown', outer);
  });

  it('New tab is the one route that opens a tab', () => {
    deliverPdfBlob(pdf(), 'x.pdf', 'preview');
    buttonNamed('New tab').click();
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
  });
});
