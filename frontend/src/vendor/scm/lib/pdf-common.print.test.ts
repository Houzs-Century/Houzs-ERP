/* Print now. Pinned: 'print' opens a NEW TAB of our own, writes the document into it
   full-size with a Print button and a Download link, and asks the viewer for
   the print dialog once it has loaded (after a settle); the Print button asks
   again; a blocked popup falls back to the hidden iframe of old; 'preview'
   and 'save' are untouched. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverPdfBlob } from './pdf-common';

type FakeTab = {
  document: Document;
  setTimeout: (fn: () => void, ms: number) => number;
  location: { replace: (p: string) => void };
};

const makeTab = (): FakeTab => {
  const doc = document.implementation.createHTMLDocument('');
  /* A real about:blank is empty and document.write replaces it; jsdom's created
     document already has a head and body and write() would only append, so it
     is opened first — the shape the browser hands us. */
  doc.open();
  return { document: doc, setTimeout: (fn, ms) => window.setTimeout(fn, ms), location: { replace: vi.fn() } };
};

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:http://erp/abc';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  openSpy?.mockRestore();
  document.body.innerHTML = '';
});

describe("Print now — the document in its own tab, the dialog asked for there", () => {
  it('writes the wrapper (title, Print button, Download link, the PDF full-size) and prints once the viewer loaded', () => {
    const tab = makeTab();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    deliverPdfBlob(new Blob(['%PDF'], { type: 'application/pdf' }), 'payment-corrections-2026-09.pdf', 'print');
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(tab.document.title).toBe('payment-corrections-2026-09');
    const frame = tab.document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('blob:http://erp/abc');
    expect(tab.document.querySelector('button[data-print]')?.textContent).toBe('Print');
    expect((tab.document.querySelector('a[download]') as HTMLAnchorElement).getAttribute('download')).toBe('payment-corrections-2026-09.pdf');
    /* No hidden iframe on the opener — the old way is not also taken. */
    expect(document.body.querySelector('iframe')).toBeNull();

    const print = vi.fn();
    const focus = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { print, focus }, configurable: true });
    frame.dispatchEvent(new Event('load'));
    expect(print).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
    /* The button asks again. */
    (tab.document.querySelector('button[data-print]') as HTMLButtonElement).click();
    expect(print).toHaveBeenCalledTimes(2);
  });

  it('a viewer that refuses does not throw out of the tab', () => {
    const tab = makeTab();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    deliverPdfBlob(new Blob(['%PDF'], { type: 'application/pdf' }), 'x.pdf', 'print');
    const frame = tab.document.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentWindow', { value: { print: () => { throw new Error('not ready'); }, focus: () => {} }, configurable: true });
    frame.dispatchEvent(new Event('load'));
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
  });

  it('a blocked popup falls back to the hidden iframe of old', () => {
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    deliverPdfBlob(new Blob(['%PDF'], { type: 'application/pdf' }), 'x.pdf', 'print');
    const frame = document.body.querySelector('iframe') as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('src')).toBe('blob:http://erp/abc');
    expect(frame.style.width).toBe('0px');
  });

  it("'preview' still opens the named tab without asking for the dialog", () => {
    const tab = makeTab();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    deliverPdfBlob(new Blob(['%PDF'], { type: 'application/pdf' }), 'x.pdf', 'preview');
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    /* The preview writes its page after an await (the worker probe); the print
       dialog is never part of it. */
    return vi.runAllTimersAsync().then(() => {
      const frame = tab.document.querySelector('iframe') as HTMLIFrameElement | null;
      if (frame) {
        const print = vi.fn();
        Object.defineProperty(frame, 'contentWindow', { value: { print, focus: vi.fn() }, configurable: true });
        frame.dispatchEvent(new Event('load'));
        vi.advanceTimersByTime(1000);
        expect(print).not.toHaveBeenCalled();
      }
    });
  });
});
