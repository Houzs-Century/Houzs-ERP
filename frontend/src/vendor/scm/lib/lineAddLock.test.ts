/* ONE answer to "may a line be added to this document", read by desktop AND phone.
 *
 * The truth tables pin each rule. The source scan pins the part that actually
 * failed in this repo before: a rule that lives in a shared module on paper,
 * while a page quietly keeps its own inline copy. Each desktop editor must call
 * the shared function, and none may still compute its own `isLocked` from status.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  goodsReceiptLinesLocked,
  purchaseInvoiceLinesLocked,
  purchaseOrderLinesLocked,
  salesInvoiceLinesOpen,
} from './line-add-lock';

describe('purchaseOrderLinesLocked', () => {
  it('is open while DRAFT, SUBMITTED or PARTIALLY_RECEIVED with no goods receipt', () => {
    for (const status of ['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED']) {
      expect(purchaseOrderLinesLocked({ status, has_children: false }), status).toBe(false);
    }
  });
  it('locks once a goods receipt exists', () => {
    expect(purchaseOrderLinesLocked({ status: 'SUBMITTED', has_children: true })).toBe(true);
    expect(purchaseOrderLinesLocked({ status: 'PARTIALLY_RECEIVED', has_children: true })).toBe(true);
  });
  it('locks RECEIVED and CANCELLED whatever the children say', () => {
    expect(purchaseOrderLinesLocked({ status: 'RECEIVED', has_children: false })).toBe(true);
    expect(purchaseOrderLinesLocked({ status: 'CANCELLED', has_children: false })).toBe(true);
  });
  it('locks a header with no status', () => {
    expect(purchaseOrderLinesLocked({ status: null, has_children: null })).toBe(true);
  });
});

describe('goodsReceiptLinesLocked', () => {
  it('is open while DRAFT, and while POSTED with nothing downstream', () => {
    expect(goodsReceiptLinesLocked({ status: 'DRAFT', has_children: false })).toBe(false);
    expect(goodsReceiptLinesLocked({ status: 'POSTED', has_children: false })).toBe(false);
  });
  it('locks a POSTED receipt that a purchase invoice or return hangs off', () => {
    expect(goodsReceiptLinesLocked({ status: 'POSTED', has_children: true })).toBe(true);
  });
  it('locks CANCELLED and CLOSED', () => {
    expect(goodsReceiptLinesLocked({ status: 'CANCELLED', has_children: false })).toBe(true);
    expect(goodsReceiptLinesLocked({ status: 'CLOSED', has_children: false })).toBe(true);
  });
});

describe('purchaseInvoiceLinesLocked', () => {
  it('is open on a DRAFT or POSTED invoice with nothing paid', () => {
    expect(purchaseInvoiceLinesLocked({ status: 'DRAFT', paid_sen: 0 })).toBe(false);
    expect(purchaseInvoiceLinesLocked({ status: 'POSTED', paid_sen: null })).toBe(false);
  });
  it('locks once any payment is recorded', () => {
    expect(purchaseInvoiceLinesLocked({ status: 'POSTED', paid_sen: 1 })).toBe(true);
  });
  it('locks a CANCELLED invoice', () => {
    expect(purchaseInvoiceLinesLocked({ status: 'CANCELLED', paid_sen: 0 })).toBe(true);
  });
});

describe('salesInvoiceLinesOpen', () => {
  it('opens a DRAFT only', () => {
    expect(salesInvoiceLinesOpen({ status: 'DRAFT' })).toBe(true);
    expect(salesInvoiceLinesOpen({ status: 'draft' })).toBe(true);
    for (const status of ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', null]) {
      expect(salesInvoiceLinesOpen({ status }), String(status)).toBe(false);
    }
  });
});

describe('every surface reads these rules, none keeps its own copy', () => {
  const read = (rel: string): string => {
    for (const r of ['frontend/src/', 'src/']) {
      for (const base of [process.cwd(), resolve(process.cwd(), '..')]) {
        try { return readFileSync(resolve(base, r + rel), 'utf8'); } catch { /* next */ }
      }
    }
    throw new Error(`${rel} not found from ${process.cwd()} — this scan must never pass on an empty read`);
  };
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const DESKTOP: Array<[string, string]> = [
    ['pages/scm-v2/PurchaseOrderDetail.tsx', 'purchaseOrderLinesLocked'],
    ['pages/scm-v2/GoodsReceivedDetail.tsx', 'goodsReceiptLinesLocked'],
    ['pages/scm-v2/PurchaseInvoiceDetail.tsx', 'purchaseInvoiceLinesLocked'],
    ['pages/scm-v2/SalesInvoiceDetailV2.tsx', 'salesInvoiceLinesOpen'],
  ];

  for (const [file, fn] of DESKTOP) {
    it(`${file} decides with ${fn}`, () => {
      expect(code(read(file))).toContain(`${fn}(`);
    });
  }

  it('no desktop editor still computes isLocked from status inline', () => {
    for (const [file] of DESKTOP.slice(0, 3)) {
      const src = code(read(file));
      const line = src.split('\n').find((l) => /const isLocked\s*=/.test(l)) ?? '';
      expect(line, file).not.toMatch(/status\s*===/);
    }
  });
});
