// WHAT REACHES AUTOCOUNT WHEN LOGISTICS SIGNS A DELIVERY OFF: nothing, and this
// file is the runnable form of that answer.
//
// THE OWNER'S QUESTION, 2026-09-08: 「然后确保 Autocount 也会钱收到 … 也会签收到」
// — he is opening the ERP to staff and needs the two state changes staff make in
// the field to reach the account book: the payment, and the delivery sign-off.
//
// THE ACCOUNT BOOK HAS NO SIGN-OFF TO REACH. A delivery order in AutoCount is a
// stock document: the goods leave the book when the document is CREATED there
// (`/so-to-do`, which the ERP already sends), and the receivable arises at the
// INVOICE (`/do-to-iv`). Arrival at the customer's door is a fact the ERP tracks
// and AutoCount has no field for. So nothing needs to travel, and THAT IS
// ALIGNMENT — not a hole. The evidence, including the one read that is still
// unmeasured, is in `docs/modules/delivery-order.md` ("Does a sign-off reach
// AutoCount?").
//
// WHY PIN IT. "Nothing travels" is exactly the shape of the payment gap found the
// same day — 45 orders collected in AutoCount, nothing in the ERP, RM 171,400 we
// were about to chase customers for — so a future reader will and should re-ask
// this. If someone builds the route, these tests fail, which forces the doc and
// the owner's answer to be rewritten together rather than one of them going
// stale.
//
// The three properties, each a different kind of evidence:
//   1. BEHAVIOURAL — the DO's /edit header composer, run for real on a signed,
//      delivered row carrying its POD evidence. No status, no signature, no
//      timestamp is projected.
//   2. BEHAVIOURAL — the ERP's whole AutoCount operation vocabulary (`AC_ROUTE`).
//      There is no sign-off operation to enqueue.
//   3. STRUCTURAL — the status handler itself. It needs a live database and a
//      Hono context to execute (the same reason doStockLeavesOnConfirm.test.ts
//      pins rather than runs it), so the source is held to the shape the answer
//      above depends on: its ONE AutoCount enqueue is the cancel, and it is
//      inside the CANCELLED branch.
// This file reads source with `node:fs`, so it must run in the LIGHT project —
// workerd has no filesystem and the whole file would be reported as neither
// passed nor failed. It gets there by the classifier's TEXT SCAN (it names no
// Workers binding), NOT by a `@vitest-project` directive: `classifyTests.test.mjs`
// asserts that only the classifier's own test may override its own rule.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { downstreamEditHeader } from '../src/scm/lib/autocount-convert-lines';
import { AC_ROUTE } from '../src/services/autocount-writeback';

const ROUTE = readFileSync(
  resolve(__dirname, '../src/scm/routes/delivery-orders-mfg.ts'),
  'utf8',
);

/* The handler, sliced out by its own declaration so the assertions below cannot
   read a neighbouring route's enqueue. It THROWS rather than returns empty if
   either end moves: a slice that silently matched nothing would pass every
   assertion here while proving none of them. */
function statusHandlerSource(): string {
  const start = ROUTE.indexOf('export const patchDeliveryOrderStatusHandler');
  if (start < 0) throw new Error('patchDeliveryOrderStatusHandler is gone from delivery-orders-mfg.ts — this pin cannot answer');
  const end = ROUTE.indexOf('deliveryOrdersMfg.patch(', start);
  if (end < 0) throw new Error('the /:id/status mount no longer follows the handler — this pin cannot answer');
  return ROUTE.slice(start, end);
}

describe('a signed-off delivery composes no sign-off for AutoCount', () => {
  /* A delivery order as it stands the moment a driver closes it: DELIVERED,
     signed, with the customer's signature, the photo key and the GPS fix. */
  const signedOffDo = {
    id: 'do-uuid',
    do_number: 'HC-DO-2609-001',
    do_date: '2026-09-08',
    debtor_name: 'A CUSTOMER SDN BHD',
    ref: 'REF-1',
    phone: '0123456789',
    note: 'leave at the guardhouse',
    linked_ac_docno: 'DO-011260',
    status: 'DELIVERED',
    signed_at: '2026-09-08T02:00:00Z',
    delivered_at: '2026-09-08T02:00:00Z',
    dispatched_at: '2026-09-08T00:00:00Z',
    signature_data: 'data:image/png;base64,iVBORw0KGgo=',
    pod_r2_key: 'pod/do-uuid.jpg',
    pod_lat: 3.139,
    pod_lng: 101.6869,
    pod_accuracy_m: 8,
    pod_located_at: '2026-09-08T02:00:00Z',
  };

  it('the /edit header carries the document, never its delivery state', () => {
    const header = downstreamEditHeader('DO', signedOffDo);
    /* The whole projection, asserted as a SET rather than key by key: a new key
       appearing is the event this test exists to catch, and a subset assertion
       would not see it. FIVE keys. `DocDate` is in the DO's facts and NOT in `AC_EDIT_HEADER_KEYS`,
       so the edit route cannot even move the delivery's own date — which puts the
       size of the surface in proportion: the account book's delivery order is a
       name, an address, a phone and two free-text fields. */
    expect(Object.keys(header).sort()).toEqual(
      ['Attention', 'DebtorName', 'Note', 'Phone1', 'Ref'].sort(),
    );
  });

  it('no sign-off fact is projected under any name', () => {
    const composed = JSON.stringify(downstreamEditHeader('DO', signedOffDo));
    for (const fact of [
      'DELIVERED', 'SIGNED',
      signedOffDo.signed_at, signedOffDo.delivered_at,
      signedOffDo.signature_data, signedOffDo.pod_r2_key,
      String(signedOffDo.pod_lat), String(signedOffDo.pod_lng),
    ]) {
      expect(composed).not.toContain(fact);
    }
  });

  it('a DRAFT and a signed-off delivery compose the SAME AutoCount header', () => {
    /* The sharpest form of "the book has no sign-off": the account book cannot
       tell the two apart, because the difference is not in anything it holds. */
    const draft = {
      ...signedOffDo,
      status: 'DRAFT',
      signed_at: null,
      delivered_at: null,
      signature_data: null,
      pod_r2_key: null,
    };
    expect(downstreamEditHeader('DO', draft)).toEqual(downstreamEditHeader('DO', signedOffDo));
  });
});

describe('the ERP has no AutoCount operation for a sign-off', () => {
  it('AC_ROUTE is the eleven operations, and none of them is a sign-off', () => {
    expect(Object.keys(AC_ROUTE).sort()).toEqual([
      'cancel', 'create_po', 'create_so', 'do_to_iv', 'edit', 'ensure_masters',
      'gr_to_pi', 'health', 'po_to_gr', 'so_to_do', 'so_to_po',
    ]);
  });

  it('no route name mentions delivery, signing or proof', () => {
    for (const route of Object.values(AC_ROUTE)) {
      expect(route).not.toMatch(/sign|deliver|pod|receipt|acknowledg/i);
    }
  });
});

describe('the DO status handler enqueues one AutoCount operation, and it is the cancel', () => {
  const handler = statusHandlerSource();

  it('the slice is real', () => {
    // Self-check: an empty or truncated slice would pass every test below.
    expect(handler.length).toBeGreaterThan(2000);
    expect(handler).toContain("toStatus === 'CANCELLED'");
  });

  it('exactly one AutoCount call, and it is enqueueCancel', () => {
    /* BOTH SPELLINGS. This route does not only call `enqueue*` directly — it has
       its OWN wrapper, `queueAcDoEdit`, and the first draft of this test matched
       only the former. Injecting `await queueAcDoEdit(c, id);` into the DELIVERED
       branch left all nine assertions GREEN, which is a pin failing to be a pin.
       The RED was bought before the green was trusted. */
    const calls = handler.match(/\b(?:enqueue[A-Z]\w*|queueAc\w*|callAcService)\s*\(/g) ?? [];
    expect(calls).toEqual(['enqueueCancel(']);
  });

  it('that enqueue sits inside the CANCELLED branch, past every sign-off hop', () => {
    const cancelBranch = handler.lastIndexOf("if (toStatus === 'CANCELLED')");
    const enqueue = handler.indexOf('enqueueCancel(');
    expect(cancelBranch).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(cancelBranch);
  });

  it('the DELIVERED branch syncs the sales order and asks AutoCount nothing', () => {
    /* The arrival hop's whole downstream effect: the SO's delivered coverage.
       Named here so that adding an AutoCount call to it breaks this file. */
    /* The BRACE is load-bearing: `if (toStatus === 'DELIVERED')  ts.delivered_at
       = now;` is a one-liner higher up, and slicing from it would take in the
       cancel branch and make this assertion answer a different question. */
    const from = handler.indexOf("if (toStatus === 'DELIVERED') {");
    expect(from).toBeGreaterThan(-1);
    const nextBranch = handler.indexOf("if (toStatus === 'CANCELLED') {", from);
    expect(nextBranch).toBeGreaterThan(from);
    const deliveredBranch = handler.slice(from, nextBranch);
    expect(deliveredBranch).toContain('syncSoDeliveredFromDo');
    expect(deliveredBranch).not.toMatch(/enqueue|queueAc|callAcService|autocount/i);
  });
});
