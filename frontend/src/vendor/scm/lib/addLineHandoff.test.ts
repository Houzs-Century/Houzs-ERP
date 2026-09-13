/* The handoff that makes "add a line" findable from the page you start on.
 *
 * The owner could not find it on a goods receipt: the detail page said nothing
 * about lines, and the affordance only appeared after pressing Edit, under a
 * fourth different name ("Add manual item" / "Add item" / "+ Add Line Item").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADD_LINE_HASH, ADD_LINE_LABEL, addLineHref, wantsAddLine, consumedAddLine,
} from './add-line-handoff';

describe('addLineHref', () => {
  it('opens the editor at the add row', () => {
    expect(addLineHref('/scm/grns/abc')).toBe('/scm/grns/abc?edit=1#add-line');
  });

  it('keeps a query the detail page was already carrying', () => {
    /* A detail page can hold a tab or a return-to; dropping it loses the
       operator's place on the way back. */
    expect(addLineHref('/scm/grns/abc?from=list')).toBe('/scm/grns/abc?from=list&edit=1#add-line');
  });

  it('does not stack a second edit flag when one is already there', () => {
    expect(addLineHref('/scm/grns/abc?edit=1')).toBe('/scm/grns/abc?edit=1#add-line');
  });

  it('ignores a fragment the caller happened to pass in', () => {
    expect(addLineHref('/scm/grns/abc#lines')).toBe('/scm/grns/abc?edit=1#add-line');
  });
});

describe('wantsAddLine', () => {
  it('recognises the intent from a full location or from the bare hash', () => {
    expect(wantsAddLine('/scm/grns/abc?edit=1#add-line')).toBe(true);
    expect(wantsAddLine(ADD_LINE_HASH)).toBe(true);
  });

  it('is false for every other fragment, and for none at all', () => {
    expect(wantsAddLine('/scm/grns/abc?edit=1')).toBe(false);
    expect(wantsAddLine('/scm/grns/abc#lines')).toBe(false);
    expect(wantsAddLine('#add-line-item')).toBe(false);
    expect(wantsAddLine('')).toBe(false);
    expect(wantsAddLine(null)).toBe(false);
    expect(wantsAddLine(undefined)).toBe(false);
  });
});

describe('consumedAddLine', () => {
  it('drops the fragment so the intent fires ONCE', () => {
    /* Left on the URL it re-opens the add row on every remount, which on a page
       that remounts after a save is a form that will not stay shut. */
    expect(consumedAddLine('/scm/grns/abc?edit=1#add-line')).toBe('/scm/grns/abc?edit=1');
  });

  it('leaves a location that never carried one alone', () => {
    expect(consumedAddLine('/scm/grns/abc?edit=1')).toBe('/scm/grns/abc?edit=1');
  });
});

describe('one name', () => {
  it('is the word every page uses now', () => {
    expect(ADD_LINE_LABEL).toBe('Add line');
  });
});

describe('every document that CAN add a line offers it from the page you start on', () => {
  /* The complaint was not "the feature is missing", it was "I cannot find it".
     So the assertion is about REACH: each detail page must both build the
     handoff URL and print the shared word, and each editor must consume the
     handoff. A page that adds one and forgets the other is the half-wiring that
     put the affordance out of sight in the first place. */
  const read = (rel: string): string => {
    const roots = ['frontend/src/', 'src/'];
    for (const r of roots) {
      try { return readFileSync(resolve(process.cwd(), r + rel), 'utf8'); } catch { /* try next */ }
    }
    for (const r of roots) {
      try { return readFileSync(resolve(process.cwd(), '..', r + rel), 'utf8'); } catch { /* try next */ }
    }
    throw new Error(`${rel} not found from ${process.cwd()} — this scan must never pass on an empty read`);
  };

  const DETAIL_PAGES = [
    'pages/scm-v2/GoodsReceivedDetailV2.tsx',
    'pages/scm-v2/PurchaseInvoiceDetailV2.tsx',
    'pages/scm-v2/PurchaseOrderDetailV2.tsx',
    'pages/scm-v2/SalesOrderDetailV2.tsx',
  ];
  const EDITORS = [
    'pages/scm-v2/GoodsReceivedDetail.tsx',
    'pages/scm-v2/PurchaseInvoiceDetail.tsx',
    'pages/scm-v2/PurchaseOrderDetail.tsx',
    'pages/scm-v2/SalesOrderDetail.tsx',
  ];

  for (const page of DETAIL_PAGES) {
    it(`${page} sends the operator to the add row, by name`, () => {
      const src = read(page);
      expect(src).toContain('addLineHref');
      expect(src).toContain('ADD_LINE_LABEL');
    });
  }

  for (const editor of EDITORS) {
    it(`${editor} opens its add row on the handoff, and consumes it`, () => {
      const src = read(editor);
      /* Through the shared hook, not a per-file paste: the first version of
         this WAS a per-file paste, and in two of the four files it landed below
         an early return — a rules-of-hooks violation the linter caught. */
      expect(src).toContain('useAddLineHandoff');
      expect(src).toContain('addLineHandoff.current =');
    });
  }

  it('no editor still spells the action its own way', () => {
    /* Four documents had four names. A page that reintroduces one is a page
       the owner will not find the button on. */
    for (const editor of EDITORS) {
      const src = read(editor)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src, editor).not.toMatch(/<span>Add (manual )?item<\/span>/i);
      expect(src, editor).not.toMatch(/<span>Add Line Item<\/span>/i);
    }
  });
});
