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

  it('the SALES INVOICE uses the shared word WITHOUT a handoff — it has no editor to hand off to', () => {
    /* The fifth document, added 2026-09-13. Its add row opens IN PLACE on
       `SalesInvoiceDetailV2.tsx`, because unlike the four above it has no
       separate V1 editor page and `addLineHref` would point at nothing. The
       word on the button is still the shared one, which is the part the owner
       reads; asserting the ABSENCE of `addLineHref` here stops a later sweep
       "fixing" this page into a link to a page that does not exist. */
    const page = read('pages/scm-v2/SalesInvoiceDetailV2.tsx');
    expect(page).toContain('useSalesInvoiceAddLine');
    expect(page).not.toContain('addLineHref');
    expect(read('pages/scm-v2/SalesInvoiceAddLine.tsx')).toContain('ADD_LINE_LABEL');
  });

  it('the PHONE offers it on the same four purchase / sales documents, by the same word', () => {
    /* Owner 2026-09-12: 「电脑版本有的，手机版本都要有」. Until 2026-09-13
       `grep ADD_LINE_LABEL frontend/src/mobile` was empty: the phone could add a
       line to none of these documents. The mobile detail has no separate editor,
       so the row opens in place (as the sales invoice's does on desktop) — hence
       no addLineHref here either. Reach is asserted three ways: the phone module
       prints the shared word, the detail screen MOUNTS it, and the module maps
       exactly the documents the desktop offers it on. */
    const row = read('mobile/MobileAddLine.tsx');
    expect(row).toContain('ADD_LINE_LABEL');
    expect(row).not.toContain('addLineHref');
    expect(read('mobile/MobileModuleDetail.tsx')).toContain('<MobileAddLine');
    const map = read('mobile/mobile-add-line.ts');
    for (const key of ['"mfg-purchase-orders": "po"', 'grns: "grn"', '"purchase-invoices": "pi"', '"sales-invoices": "si"']) {
      expect(map, key).toContain(key);
    }
  });

  it('the PHONE decides "still open for a line" with the same rules the desktop editors use', () => {
    /* A phone copy of the lock would be invisible to check-shared-mirrors.
       The desktop editors and the phone must import the same functions. */
    const map = read('mobile/mobile-add-line.ts');
    expect(map).toContain("from \"../vendor/scm/lib/line-add-lock\"");
    for (const fn of ['purchaseOrderLinesLocked', 'goodsReceiptLinesLocked', 'purchaseInvoiceLinesLocked', 'salesInvoiceLinesOpen']) {
      expect(map, fn).toContain(`${fn}(`);
    }
  });

  it('the PHONE sales order offers it from the detail and hands off to the editor with a new line open', () => {
    /* The phone SO editor (MobileNewSO) could already add a line, under the
       retired spelling "+ Add Line Item", and only after pressing Edit: the same
       unfindable-affordance shape 0853 fixed on desktop. Reach, asserted: the
       detail prints the shared word and calls the handoff; the shell carries the
       intent; the editor consumes it and no longer spells the action its own way. */
    const detail = read('mobile/MobileSODetail.tsx');
    expect(detail).toContain('ADD_LINE_LABEL');
    expect(detail).toContain('onAddLine(docNo)');
    expect(read('mobile/MobileApp.tsx')).toContain('addLine: true');
    const editor = read('mobile/MobileNewSO.tsx');
    expect(editor).toContain('openAddLine');
    expect(editor).toContain('ADD_LINE_LABEL');
    expect(editor).not.toMatch(/\+ Add Line Item</);
  });

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
