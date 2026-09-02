// ----------------------------------------------------------------------------
// ONE RULE FOR ALL SIX DOCUMENT TYPES: a deleted line disappears.
//
// Owner 2026-09-02, on why the connector this one replaces only ever wrote sales
// orders:
//
//   「他只做 Sales Order 是因为他那边只有 Sales Order 的 Data Entry，我们这里是
//     有全部 Document 的 Data Entry 的（我们是 Full Set）。所以你需要把全部东西
//     都 update 掉」
//
// and then: 「不要有规则变形，或者说没有清楚规则的这种 business logic 问题」.
//
// So the rule may not be "sales orders behave one way and the rest another
// because of how the SDK happens to be shaped". The rule is ONE sentence — a
// deleted line disappears — and the SDK decides only the MECHANISM: delete that
// one line where it can, rebuild the details where it cannot.
//
// This file exists because that is exactly the kind of rule that rots into six
// per-type special cases.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  SDK_DELETES_ONE_LINE, rebuildNeededToRemoveLine,
} from '../src/services/ac-line-gone';
import sdkRef from '../scripts/autocount-service/sdk-api-reference.txt?raw';
import writebackSrc from '../src/services/autocount-writeback.ts?raw';

/* LINE ENDINGS ARE NORMALISED FIRST, and that is not tidiness. `core.autocrlf`
   gives the working tree CRLF on Windows, so a matcher anchored on a bare
   newline silently finds nothing and the test passes against the very source it
   was written to reject. That has happened three times in one day in this repo:
   here, in acLineOrderWiring, and in doStockLeavesOnConfirm — which still fails
   locally for exactly this reason. Normalise once, then match on LF. */
const lf = (s: string): string => s.split('\r\n').join('\n');
const code = (s: string): string =>
  lf(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const WRITEBACK = code(writebackSrc);
const SDK = lf(sdkRef);

/** The six types the write-back handles. Written out, and asserted complete
 *  against the table itself so neither can drift alone. */
const ALL_TYPES = ['SO', 'PO', 'GR', 'DO', 'IV', 'PI'] as const;

/** The SDK class each type maps to, for reading the reference file. */
const CLASS: Record<string, string> = {
  SO: 'AutoCount.Invoicing.Sales.SalesOrder.SalesOrder',
  PO: 'AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrder',
  GR: 'AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNote',
  DO: 'AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrder',
  IV: 'AutoCount.Invoicing.Sales.Invoice.Invoice',
  PI: 'AutoCount.Invoicing.Purchase.PurchaseInvoice.PurchaseInvoice',
};

describe('every document type has an answer, and it is the same rule', () => {
  test('the table covers all six and nothing else', () => {
    expect(Object.keys(SDK_DELETES_ONE_LINE).sort()).toEqual([...ALL_TYPES].sort());
  });

  test.each(ALL_TYPES)('%s: a deleted line always leads to a removal', (t) => {
    /* Either the SDK removes the one line, or the rebuild removes it by laying
       the document down again. What must never happen is NEITHER — that is the
       "marked at qty 0 and still visible" state the owner could see. */
    const oneLine = SDK_DELETES_ONE_LINE[t] === true;
    const rebuilds = rebuildNeededToRemoveLine(t, true);
    expect(oneLine || rebuilds, `${t} would leave a deleted line in the book`).toBe(true);
    expect(oneLine && rebuilds, `${t} would do BOTH, which is a contradiction`).toBe(false);
  });

  test.each(ALL_TYPES)('%s: NO deletion never triggers a rebuild', (t) => {
    /* A rebuild destroys every DtlKey. It may only ever be the price of removing
       a line, never a side effect of an ordinary edit. */
    expect(rebuildNeededToRemoveLine(t, false)).toBe(false);
  });

  /* The mechanism table is the SDK's fact, not ours. Asserted against the
     reference file so a later SDK that adds DeleteDetail to PurchaseOrder fails
     here rather than leaving five types rebuilding for no reason. */
  test.each(ALL_TYPES)('%s: the table matches what the SDK reference says', (t) => {
    const i = SDK.indexOf(`--- ${CLASS[t]}\n`);
    if (i === -1) {
      /* The reference does not carry this class. Say so rather than passing
         quietly — an unfound class must not read as "no DeleteDetail". */
      expect(SDK_DELETES_ONE_LINE[t], `${CLASS[t]} is absent from the SDK reference, `
        + 'so it may only be listed as UNABLE to delete one line').toBe(false);
      return;
    }
    const body = SDK.slice(i, i + 6000);
    const meth = body.slice(body.indexOf('METH:'), body.indexOf('\n\n'));
    expect(meth.length, `no METH: block found for ${CLASS[t]}`).toBeGreaterThan(20);
    expect(meth.includes('DeleteDetail(')).toBe(SDK_DELETES_ONE_LINE[t] === true);
  });
});

describe('the rule is applied in ONE place, not per caller', () => {
  test('composeEdit derives it — a caller cannot forget it', () => {
    expect(WRITEBACK).toMatch(/rebuildNeededToRemoveLine\(docType, anyDeleted\)/);
    expect(WRITEBACK).toMatch(/retired\.some\(\(r\) => r\.Gone === 'deleted'\)/);
  });

  /* An explicit `rebuild` from the caller still works — the derived rule only
     ever turns it ON, never off, so a sales order can still be rebuilt on
     request, which is how a document nobody can match is recovered. */
  test('an explicit request survives the derivation', () => {
    expect(WRITEBACK).toMatch(/\{ \.\.\.opts, rebuild: true \}/);
  });

  test('the parameter is not reassigned — the derived value is used throughout', () => {
    expect(WRITEBACK).not.toMatch(/^\s*opts = effOpts;/m);
    expect(WRITEBACK).toMatch(/composeDetails\(lines, effOpts\)/);
    expect(WRITEBACK).toMatch(/effOpts\.rebuild/);
  });
});
