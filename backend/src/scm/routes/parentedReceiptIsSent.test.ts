/* A receipt or invoice that HAS a parent must be sent as a conversion.
 *
 * Owner, 2026-08-23: 「为什么这些 sync 不到」 and 「我全部要可以 sync now 啊 而且是
 * 真的可以用的 不是摆设品」.
 *
 * WHAT WAS WRONG. POST /grns and POST /purchase-invoices recorded EVERY document
 * they created as parentless — including the ones the desktop conversion screens
 * produce, which are the normal way these documents are raised. The desktop
 * never calls /from-po-items or /from-grn-items at all; the pickers navigate to
 * the New form, and the New form posts here.
 *
 * A parentless row is not requeueable (AC_TRANSFER_OPS are requeueable only when
 * FAILED, and a parentless record is `skipped`), so the operator got no
 * Send-again button either. Measured on production 2026-08-23: four
 * goods-received notes, each showing "Goods received from a purchase order"
 * directly beside "There is no earlier document to carry across".
 *
 * WHY THE OLD REASONING WAS WRONG. The comment argued that a conversion would
 * make AutoCount transfer the PO's outstanding lines rather than the typed
 * quantities. That is true only when the payload omits DtlKeys. The ERP names
 * the subset it took — readConvertSourceKeys, called inside enqueueConvert —
 * and refuses when it cannot name every line. That is the same shape
 * /from-po-items sends.
 *
 * These cases assert BOTH directions, because a fix that sends everything is a
 * different bug: a genuinely hand-built receipt has no parent to name, and must
 * still be recorded as parentless rather than sent as a transfer of nothing.
 */
import { describe, expect, it } from 'vitest';
/* `?raw`, not node:fs — this is a Workers project and node types are not in the
   tsconfig, so a fs import typechecks red while the tests pass. The repo's other
   source-reading test (lib/return-unlinked-lines.test.ts) reads the same router
   the same way. */
import grnsSrc from './grns.ts?raw';
import piSrc from './purchase-invoices.ts?raw';

const src = (f: string) => (f === 'grns.ts' ? grnsSrc : piSrc);
/* Returns '' when either anchor is absent, and NEVER throws at module scope.
   A source-reading test that dies while loading reports as "no tests", which
   reads like a corrupt file rather than a failure — the exact shape CLAUDE.md
   calls a verdict computed over nothing. Absent anchors have to fail INSIDE a
   case, where the message says which assertion did not hold. */
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  if (a < 0) return '';
  const b = text.indexOf(to, a + 1);
  return b > a ? text.slice(a, b) : '';
};

describe('POST /grns — a receipt raised from a purchase order is SENT', () => {
  const body = () => between(src('grns.ts'), 'const srcPoIds = await sourcePoIdsForGrn', 'const movementErrors');

  it('enqueues a po_to_gr conversion when the lines name a purchase order', () => {
    expect(body()).toContain("op: 'po_to_gr'");
    expect(body()).toContain("table: 'purchase_orders'");
  });

  it('still records parentless when NO line names one', () => {
    expect(body()).toContain('recordParentlessCreate');
    expect(body()).toContain("missing: 'no source Purchase Order'");
  });

  it('names the source from the LINES, never from the header hint', () => {
    /* body.purchaseOrderId is a field the form may or may not carry;
       grn_items.purchase_order_item_id is what the conversion will name. */
    const helper = between(src('grns.ts'), 'async function sourcePoIdsForGrn', '\n}\n');
    expect(helper, 'sourcePoIdsForGrn is missing').not.toBe('');
    expect(helper).toContain('purchase_order_item_id');
    expect(helper).not.toContain('body.purchaseOrderId');
  });
});

describe('POST /purchase-invoices — an invoice billing a receipt is SENT', () => {
  const body = () => between(src('purchase-invoices.ts'), 'const srcGrnIds = await sourceGrnIdsForPi', 'LEAK GUARD (DRAFT)');

  it('enqueues a gr_to_pi conversion when the lines name a receipt', () => {
    expect(body()).toContain("op: 'gr_to_pi'");
    expect(body()).toContain("table: 'grns'");
  });

  it('still records parentless when NO line names one', () => {
    expect(body()).toContain('recordParentlessCreate');
    expect(body()).toContain('no source Goods Received Note');
  });

  it('names the source from the LINES', () => {
    const helper = between(src('purchase-invoices.ts'), 'async function sourceGrnIdsForPi', '\n}\n');
    expect(helper, 'sourceGrnIdsForPi is missing').not.toBe('');
    expect(helper).toContain('grn_item_id');
  });
});
