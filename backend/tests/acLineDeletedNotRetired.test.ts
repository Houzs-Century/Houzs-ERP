// ----------------------------------------------------------------------------
// DELETED and CANCELLED are not the same word.
//
// Owner 2026-09-02, shown that a line he deleted in the ERP was still sitting in
// AutoCount at Qty 0 marked [ERP-CANCELLED]: 「跟 inistate 一样」 — the connector
// this one replaces really called DeleteDetail.
//
// The ERP says WHAT HAPPENED (`Gone: 'deleted'`); the host decides what the book
// can do about it, because only the host can see whether the book's own line has
// already been transferred. This file pins our half.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import outboxSrc from '../src/scm/lib/autocount-outbox.ts?raw';
import writebackSrc from '../src/services/autocount-writeback.ts?raw';
import goneSrc from '../src/services/ac-line-gone.ts?raw';
import serviceSrc from '../scripts/autocount-service/AcSyncService.cs?raw';
import sdkRef from '../scripts/autocount-service/sdk-api-reference.txt?raw';

const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const OUTBOX = code(outboxSrc);
const WRITEBACK = code(writebackSrc);
/* The reason type lives in its own module — autocount-writeback.ts sits at the
   2000-line cap, so the explanation could not go there. */
const GONE = code(goneSrc);
const SERVICE = code(serviceSrc);

describe('a deleted line is declared as deleted, not as a retirement', () => {
  test('the payload carries the reason, and ABSENT means retire', () => {
    expect(WRITEBACK).toMatch(/Gone\?: AcLineGoneReason;/);
    expect(GONE).toMatch(/AcLineGoneReason = 'deleted' \| 'cancelled'/);
  });

  /* Every caller of `retiredLineOf` is a DELETE route, so the stamp belongs at
     that one source rather than at each of the four call sites. */
  test('retiredLineOf stamps deleted — once, where the rows are read', () => {
    expect(OUTBOX).toMatch(/Gone: 'deleted' as const/);
    expect(OUTBOX.match(/Gone: 'deleted'/g) ?? []).toHaveLength(1);
  });

  /* The cancelled-line path must NOT gain it: that line is still on the ERP
     document and has to stay visible in the book. */
  test('nothing else in the payload claims a deletion', () => {
    expect(WRITEBACK).not.toMatch(/Gone: 'deleted'/);
  });
});

describe('the host refuses the delete on all three of the book\'s own grounds', () => {
  test('the population is real — the service source actually loaded', () => {
    expect(SERVICE.length).toBeGreaterThan(1000);
    expect(SERVICE).toContain('doc.DeleteDetail(');
  });

  test('only when the ERP said DELETED', () => {
    expect(SERVICE).toMatch(/goneReason == "deleted"/);
  });

  /* SalesOrder is the only class with DeleteDetail. Asserted against the SDK
     reference itself, not against a belief about it — if a later SDK adds it to
     PurchaseOrder this test says so instead of the guard silently being wrong. */
  test('only on a SALES ORDER, and the SDK is what says so', () => {
    expect(SERVICE).toMatch(/type == "SO"/);
    const classOf = (name: string): string => {
      const i = sdkRef.indexOf(`--- ${name}`);
      return i === -1 ? '' : sdkRef.slice(i, i + 4000);
    };
    expect(classOf('AutoCount.Invoicing.Sales.SalesOrder.SalesOrder'))
      .toContain('DeleteDetail(Int64)');
    for (const cls of [
      'AutoCount.Invoicing.Purchase.PurchaseOrder.PurchaseOrder',
      'AutoCount.Invoicing.Purchase.GoodsReceivedNote.GoodsReceivedNote',
      'AutoCount.Invoicing.Sales.DeliveryOrder.DeliveryOrder',
    ]) {
      const body = classOf(cls);
      expect(body.length, `${cls} not found in the SDK reference`).toBeGreaterThan(100);
      const meth = body.slice(body.indexOf('METH:'), body.indexOf('\n\n'));
      expect(meth, `${cls} unexpectedly HAS DeleteDetail — re-read the guard`)
        .not.toContain('DeleteDetail(');
    }
  });

  /* AutoCount's own troubleshooting: deleting a transferred document's rows
     leaves the source pointing at nothing and needs raw SQL to recover. Our
     downstream lock stops US editing such a document, but somebody can transfer
     inside AutoCount without telling us — so the BOOK's figure is what decides. */
  test('never when the BOOK says the line was already transferred', () => {
    expect(SERVICE).toMatch(/transferred <= 0m/);
    expect(SERVICE).toMatch(/d\.TransferedQty/);
  });

  test('the removal happens after the enumeration, descending, and is not swallowed', () => {
    expect(SERVICE).toMatch(/toDelete\.Sort\(\);/);
    expect(SERVICE).toMatch(/toDelete\.Reverse\(\);/);
    /* Set() swallows; a silently-skipped delete is the divergence this exists
       to stop, so the call must be bare. */
    expect(SERVICE).not.toMatch(/Set\(\(\) => doc\.DeleteDetail/);
    /* The property is that a SAVE FOLLOWS the deletes — not that the deletes
       precede the first `doc.Save()` in the file, which belongs to the create
       path and sits thousands of lines earlier. Comparing against that one
       failed for a reason that had nothing to do with the code under test. */
    const del = SERVICE.indexOf('doc.DeleteDetail(');
    expect(del, 'DeleteDetail is not called at all').toBeGreaterThan(-1);
    expect(SERVICE.indexOf('doc.Save();', del), 'nothing saves after the deletes')
      .toBeGreaterThan(del);
  });

  /* An old service binary has never heard of `Gone` and reads keys by name, so
     it retires exactly as today. Shipping our half alone changes nothing until
     the host is rebuilt — which is what makes it safe to ship first. */
  test('the flag is read by name, so an un-rebuilt host ignores it', () => {
    expect(SERVICE).toMatch(/it\.ContainsKey\("Gone"\)/);
  });
});
