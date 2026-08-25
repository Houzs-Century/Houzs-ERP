import { describe, expect, test } from 'vitest';
import { composeDetails, ItemCodeError, composeSoToPo } from './autocount-writeback';
import { buildAcItemIndex } from './autocount-item-code';

/* ---------------------------------------------------------------------------
   A TRANSFER SENDS NO ItemCode, SO AN UNRESOLVABLE ONE MUST NOT REFUSE IT.

   `AddSOToPOTransferDetail(Int64)` takes a source line KEY and nothing else —
   AutoCount copies the sales line's own item into the purchase line. The ERP's
   own `composeSoToPo` matches that: DtlKey, UnitPrice, Qty, Location,
   DeliveryDate, and every ItemCode thrown away.

   Owner 2026-08-25: 「如果它是 by convert 的，那肯定是先跟 Sales Order 的 SKU
   进行 convert … SKU 可能就不用看了」.

   The code did the opposite. The transfer path composed a full CREATE payload
   first — which resolves every line's ItemCode and throws ItemCodeError — and
   only then discarded the codes. Measured 2026-08-25, 139 bindings resolve to
   `ambiguous: … none belongs to supplier`; on a transfer every one was blocking
   a document over a value that would never be sent.
   ------------------------------------------------------------------------ */

/* An ERP code the snapshot maps to TWO items, neither belonging to the supplier
   on the document — the exact shape of all 139 production refusals. */
const INDEX = buildAcItemIndex([
  'HOK-1007 (K)\tCODY-(K)\tBEDFRAME\t400-O002',
  'NB-KHJ57(K)\tCODY-(K)\tBEDFRAME\t400-N002',
].join('\n'));

const line = () => ({
  item_code: 'CODY-(K)',
  description: 'CODY KING',
  qty: 1,
  unit_price_sen: 100_00,
  location: 'KL',
} as never);

describe('an ambiguous item code refuses a CREATE and not a TRANSFER', () => {
  const opts = { supplierCode: '400-H003', itemIndex: INDEX, requireLocation: true };

  test('the create is still refused — there the ItemCode really is sent', () => {
    /* THE HALF THAT MUST NOT CHANGE. On a create the ItemCode is what opens or
       names an item in a licensed book, so an unresolved one is a refusal and
       relaxing it would be the real regression. */
    expect(() => composeDetails([line()], opts)).toThrow(ItemCodeError);
  });

  test('the transfer composes, and keeps the line', () => {
    const { details, collapsed } = composeDetails([line()], { ...opts, forTransfer: true });
    expect(details).toHaveLength(1);
    /* THE LINE MUST SURVIVE, not just the call. Dropping the unresolved line
       would silently shorten Details and misalign the DtlKey zip — a wrong
       quantity on a live purchase order rather than a refusal. */
    expect(collapsed).toHaveLength(1);
  });

  test('and what actually goes out carries no ItemCode at all', () => {
    /* The end of the chain, asserted on the BYTES: whatever composeDetails put
       in ItemCode, composeSoToPo does not send it. */
    const { details } = composeDetails([line()], { ...opts, forTransfer: true });
    const master = { DocNo: 'HC-PO-1', CreditorCode: '400-H003' } as never;
    const sent = composeSoToPo(master, [913445], details);
    expect(sent.Details).toHaveLength(1);
    expect(Object.keys(sent.Details[0]).sort())
      .toEqual(['DeliveryDate', 'DtlKey', 'Location', 'Qty', 'UnitPrice'].filter((k) => k in sent.Details[0]).sort());
    expect(sent.Details[0]).not.toHaveProperty('ItemCode');
  });
});

describe('the enqueue decides the shape BEFORE it composes', () => {
  test('readPoEnqueueShape is read above composeDetails', async () => {
    /* The ordering IS the fix. composeDetails used to run first, so the option
       that says "no ItemCode is sent" could not exist yet. */
    const src: string = (await import('../scm/lib/autocount-outbox.ts?raw')).default;
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const shapeAt = body.indexOf('readPoEnqueueShape(sb, opts.poId)');
    /* The PO block's OWN call — `composeDetails(lines,` also appears on the
       sales-order path earlier in the file, and matching that one would compare
       two unrelated positions and pass or fail by accident. */
    const composeAt = body.indexOf('composeDetails(lines, { supplierCode: header.creditor_code');
    expect(shapeAt, 'readPoEnqueueShape not found').toBeGreaterThan(-1);
    expect(composeAt, 'composeDetails not found').toBeGreaterThan(-1);
    expect(shapeAt).toBeLessThan(composeAt);
  });
});
