import { describe, expect, test } from 'vitest';
import rawSo from '../src/scm/routes/mfg-sales-orders.ts?raw';
/* The payment insert core lives below the route layer, because scan-so.ts
   writes through it with no request context. Its anchor has to be read from
   there or this test pins a function that is no longer in the file. */
import rawPaymentRow from '../src/scm/lib/so-payment-row.ts?raw';
import rawSdk from '../scripts/autocount-service/sdk-api-reference.txt?raw';
import rawPo from '../src/scm/routes/mfg-purchase-orders.ts?raw';
import rawDo from '../src/scm/routes/delivery-orders-mfg.ts?raw';
import rawGrn from '../src/scm/routes/grns.ts?raw';
import rawSi from '../src/scm/routes/sales-invoices.ts?raw';
import rawPi from '../src/scm/routes/purchase-invoices.ts?raw';
import rawCron from '../src/index.ts?raw';

/* ?raw hands back the WORKING TREE bytes, and on Windows (core.autocrlf=true)
   that is CRLF while git stores LF. Any anchor below containing a newline then
   matches in CI and not on the machine the owner actually runs this on. */
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const soSource = lf(rawSo);
const paymentRowSource = lf(rawPaymentRow);
const poSource = lf(rawPo);
const doSource = lf(rawDo);
const grnSource = lf(rawGrn);
const siSource = lf(rawSi);
const piSource = lf(rawPi);
const cronSource = lf(rawCron);

/* ERP -> AutoCount write-back: the WIRING.
 *
 * After go-live the ERP is master and every document it creates must appear in
 * AutoCount. The queue's own behaviour is unit-tested in
 * src/scm/lib/autocount-outbox.test.ts; this file makes sure a refactor cannot
 * silently unhook it from the routes — which would leave a document in the ERP
 * that AutoCount never hears about, with nothing to notice it by.
 *
 * Same source-anchored style as soConfirmGateWiring.test.ts.
 */

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

describe('the six flows are hooked at the point the document becomes permanent', () => {
  test('1. SO create — queued after the CREATE audit row, before the 201, and NOT for a draft', () => {
    /* The 201 now carries `acNotSent` when the composer refused the order — the
       refusal is computed in THIS request and used to be dropped on the floor
       (see lib/ac-preflight.ts). The anchor moved with it; what it pins has not. */
    const tail = between(soSource, "action: 'CREATE',", 'return c.json({ docNo, ...(acNotSent.length');
    expect(tail).toContain('enqueueSoCreate(sb, {');
    /* A draft is the scan job's guess awaiting an operator's verdict — it does
       not belong in a live account book. It is queued when it leaves DRAFT. */
    expect(tail).toContain("(body as { asDraft?: unknown }).asDraft === true ? []");
    expect(between(soSource, 'post-status failed', 'Edge #B')).toContain("} else if (fromNorm === 'DRAFT') {");
  });

  test('2. PO create — queued before the 201, and NOT for a draft', () => {
    const tail = between(poSource, 'await recordPoCreate(', 'return c.json({ id: header.id, poNumber: header.po_number, ...(acNotSent.length');
    expect(tail).toContain('enqueuePoCreate(supabase, {');
    expect(tail).toContain('const acNotSent = asDraft ? [] :');
    // The confirm transition is where a drafted PO becomes real.
    expect(between(poSource, "select('id, status, submitted_at')", "return c.json({ purchaseOrder: after ?? { id, status: 'SUBMITTED' }, ...(acNotSent.length"))
      .toContain('enqueuePoCreate(supabase, {');
  });

  test('3. SO -> DO — both the converter and an SO-linked manual DO', () => {
    const converter = between(doSource, 'Converted from Sales Order', 'return c.json({');
    expect(converter).toContain("op: 'so_to_do'");
    /* A DO merged from several SOs is SENT, naming every one of them. It used
       to be recorded as skipped, on a service limitation that ended 2026-08-16
       when AcSyncService learned FromDocNos. The assertion is the map over the
       source documents, because that is the thing a regression would drop —
       reverting to `docNos[0]` would ship a delivery order into the account book
       carrying one sales order's lines out of several. */
    expect(converter).toContain('docNos.map(');
    expect(converter).not.toContain('recordConvertSkipped');

    const manual = between(doSource, 'await recordDoCreate(sb,', '/* A DO = goods shipped on creation');
    expect(manual).toContain("op: 'so_to_do'");
  });

  test('4. PO -> GRN — the whole-PO receive and the per-line receive', () => {
    const wholePo = between(grnSource, 'Batch-converted from', 'const movementErrors = postRes.ok');
    expect(wholePo).toContain("op: 'po_to_gr'");
    // Every purchase order the GRN received against, not just the first.
    expect(wholePo).toContain('poList.map(');
    expect(wholePo).not.toContain('recordConvertSkipped');

    const perLine = between(grnSource, 'Received from ${[...bucket.poNumbers]', 'const postFailReason');
    expect(perLine).toContain("op: 'po_to_gr'");
    /* The bucket's own PO IDS, not `primaryPoId`. A bucket can hold several
       purchase orders and `primaryPoId` is whichever one opened it. */
    expect(perLine).toContain('bucketPoIds.map(');
  });

  test('5. DO -> Sales Invoice', () => {
    const conv = between(siSource, 'Converted from ${distinctDoNumbers.length > 1', '/* LEAK GUARD (DRAFT)');
    expect(conv).toContain("op: 'do_to_iv'");
    // Every delivery order the invoice bills.
    expect(conv).toContain('doIds.map(');
    expect(conv).not.toContain('recordConvertSkipped');
  });

  test('6. GRN -> Purchase Invoice — the whole-GRN and the per-line paths', () => {
    /* The end anchor stops at the RETURN, whatever that return now carries:
       since 2026-08-20 it also spreads `acNotSent`, so anchoring on the whole
       old line pinned a response shape this test has no opinion about. */
    const wholeGrn = between(piSource, 'Converted from Goods Receipt ${g.grn_number', 'return c.json({ id: h.id, invoiceNumber: h.invoice_number');
    expect(wholeGrn).toContain("op: 'gr_to_pi'");

    const perLine = between(piSource, 'Converted from Goods Receipt ${bucket.grnNumbers', '// Consume the GRN lines');
    expect(perLine).toContain("op: 'gr_to_pi'");
    // Every goods receipt the bucket bills; the bucket is already one supplier.
    expect(perLine).toContain('bucket.grnIds.map(');
    expect(perLine).not.toContain('recordConvertSkipped');
  });
});

describe('cancel and edit are hooked, and only where the downstream lock has already run', () => {
  test('SO cancel queues a cancel, after the status change committed', () => {
    const tail = between(soSource, 'post-status failed', 'Edge #B');
    expect(tail).toContain('if (isCancel)');
    expect(tail).toContain('enqueueCancel(sb, {');
    expect(tail).toContain("docType: 'SO'");
  });

  test('PO cancel queues a cancel', () => {
    const tail = between(poSource, "select('id, status, cancelled_at, po_number')", 'return c.json({ purchaseOrder: after');
    expect(tail).toContain('enqueueCancel(supabase, {');
    expect(tail).toContain("docType: 'PO'");
  });

  test('DO cancel queues a cancel', () => {
    const tail = between(doSource, 'post-do-cancel failed', 'return c.json({');
    expect(tail).toContain('enqueueCancel(sb, {');
    expect(tail).toContain("docType: 'DO'");
  });

  test('GRN cancel queues a cancel', () => {
    /* End anchor is a PREFIX of the response, like the PO and DO cases above:
       the handler now spreads a `cancelErrors` array into that same c.json, and
       an anchor pinned to the whole statement failed on the wording while the
       wiring it exists to protect was untouched. The window still ends at the
       response, so an enqueue that slipped past the 200 would still be caught. */
    const tail = between(grnSource, 'await recomputePoReceived(sb, lineList.map', "return c.json({ grn: data ?? { id, status: 'CANCELLED' }");
    expect(tail).toContain('enqueueCancel(sb, {');
    expect(tail).toContain("docType: 'GR'");
  });

  test('every SO mutation path queues an edit — header, line add/edit/delete, and the variant/SKU swaps', () => {
    // Header CAS save.
    expect(between(soSource, 'header saved but edit lease was no longer ours', 'version: savedVersion,'))
      .toContain('queueAcSoEdit(c, docNo');
    // Line add / edit / delete.
    expect(between(soSource, 'post-line-add failed', 'return c.json({ item: data }, 201);'))
      .toContain('queueAcSoEdit(c, docNo');
    expect(between(soSource, 'post-line-patch failed', 'return c.json({ ok: true });'))
      .toContain('queueAcSoEdit(c, docNo');
    /* The delete also RETIRES the removed line in AutoCount — without naming it
       the account book keeps it live, because /edit applies only the lines it
       is given. See autocountWritebackCells.test.ts for the all-six version. */
    expect(between(soSource, 'post-line-delete failed', 'return c.body(null, 204);'))
      .toContain('queueAcSoEdit(c, docNo, retire)');
    /* Variant / SKU changes. These run inside runScmPgCommand, so the queue
       call must sit OUTSIDE the transaction and fire only on a 2xx. */
    for (const route of ['tbc-update', 'tbc-swap', 'tbc-swap-sofa']) {
      const block = between(soSource, `mfgSalesOrders.post('/:docNo/items/:itemId/${route}'`, '});\n');
      expect(block, route).toContain('queueAcSoEditAfter(c, c.req.param(\'docNo\'), await runScmPgCommand(');
    }
  });

  /* SEPARATE TEST, DELIBERATELY, and the reason is the test above it.
     That one is called "every SO mutation path queues an edit" and checks seven
     hand-listed places. A payment is an SO mutation — it moves the outstanding
     balance, which is a value the account book holds in UDF_BALANCE — and none
     of the three payment paths were in the list, so the word "every" was false
     from the day BALANCE started being sent and the suite stayed green. The
     lesson is the one in CLAUDE.md's unverified-completeness-claim class, and
     the remedy here is to name the paths rather than widen the other test's
     claim any further. */
  test('every SO PAYMENT path queues an edit — insert, amend, delete', () => {
    /* The insert is pinned on the CORE, not on the route. scan-so.ts books its
       receipts through recordSoPaymentRow with no request context, so an
       enqueue written into POST /:docNo/payments would cover the payments a
       human typed and silently miss every scanned one. */
    expect(between(paymentRowSource, 'export async function recordSoPaymentRow(', 'return { payment: data as Record<string, unknown>, errorMessage: null };'))
      .toContain('await enqueueEdit(sb, {');
    expect(between(soSource, "action: 'UPDATE_PAYMENT',", 'collected_by_name: staff?.name ?? null'))
      .toContain('queueAcSoEdit(c, docNo)');
    /* The delete direction matters most: a book left showing a settled order
       after the payment was reversed understates what the customer owes. */
    expect(between(soSource, "action: 'DELETE_PAYMENT',", 'return c.json({ ok: true });'))
      .toContain('queueAcSoEdit(c, docNo)');
  });

  test('every PO mutation path queues an edit', () => {
    expect(soSource).toBeTruthy();
    expect(between(poSource, 'header date cascade failed', 'return c.json({ purchaseOrder: data });'))
      .toContain('queueAcPoEdit(c, id)');
    /* With the inserted row DECLARED as new, so AutoCount appends it instead of
       refusing the document for carrying a line with no key (2026-08-31). */
    expect(between(poSource, 'Line added: ${String(it.itemCode', 'return c.json({ item: data }, 201);'))
      .toContain('queueAcPoEdit(c, poId, [], data?.id');
    expect(between(poSource, "catch { /* don't fail the edit on a counter recount */ }", 'return c.json({ ok: true });'))
      .toContain('queueAcPoEdit(c, poId)');
    expect(between(poSource, "catch { /* line already deleted", 'return c.body(null, 204);'))
      .toContain('queueAcPoEdit(c, poId, retire)');
  });

  test('the SO and PO routers use the SHARED downstream lock, not a private copy', () => {
    expect(soSource).toContain("import { soHasDownstream } from '../lib/downstream-lock';");
    expect(poSource).toContain("import { poHasDownstream } from '../lib/downstream-lock';");
    expect(doSource).toContain("import { doHasDownstream } from '../lib/downstream-lock';");
    expect(grnSource).toContain("import { grnHasDownstream } from '../lib/downstream-lock';");
    // The private copies are gone — one rule, one place, one test.
    expect(soSource).not.toContain('async function soHasDownstream');
    expect(poSource).not.toContain('async function poHasDownstream');
    expect(doSource).not.toContain('async function doHasDownstream');
    expect(grnSource).not.toContain('async function grnHasDownstream');
  });
});

describe('the drain is wired to the cron', () => {
  test('runs in the 5-minute slot, best-effort, and shouts about a FAILED row', () => {
    const slot = between(cronSource, 'if (event.cron === "*/5 * * * *")', 'else if (event.cron === "*/30');
    expect(slot).toContain('drainAutoCountOutbox(env)');
    expect(slot).toContain('[cron ac-writeback] FAILED');
    expect(slot).toContain('.catch((e) => console.error("[cron ac-writeback]", e))');
  });
});

/* The sofa branch of POST /:docNo/items inserted its compartment rows and
   RETURNED - past the hook, queueing nothing. Adding a sofa to an order
   AutoCount already holds never reached the account book at all. Same shape as
   the guard-with-no-else class in BUG-HISTORY: an early return past the hook,
   which a test that only greps the file as a whole cannot see. */
test('the SOFA add-line branch queues an edit before it returns, and declares its rows', () => {
  const branch = rawSo.slice(
    rawSo.indexOf('const firstRow = (moduleData ?? [])[0]'),
    rawSo.indexOf('return c.json({ item: firstRow }, 201);'),
  );
  expect(branch.length).toBeGreaterThan(0);
  expect(branch).toContain('queueAcSoEdit(c, docNo');
  /* Declared, not inferred: the ids come from the rows this insert returned. */
  expect(branch).toContain('moduleData');
});

/* The SDK has NO un-cancel: CancelDocument is a command, not a flag, and a
   whole-file grep of the reflected surface for uncancel / Cancelled:Boolean /
   set_Cancelled returns nothing. So an ERP un-cancel has no push - it would
   leave the document live here and cancelled there, which is the divergence the
   owner named. Refusing is the only option that cannot silently diverge. */
describe('a cancel that reached AutoCount is final', () => {
  test('the SDK really has no un-cancel — the premise, not an assumption', () => {
    expect(/uncancel|set_Cancelled|Cancelled:Boolean/i.test(rawSdk)).toBe(false);
    /* And the one thing it DOES have is a command. */
    expect(rawSdk).toContain('CancelDocument');
  });

  test('the SO status route refuses to leave CANCELLED once linked_ac_docno is set', () => {
    /* Anchor changed 2026-08-18: the handler is now the named export
       patchMfgSalesOrderStatusHandler, MOUNTED at the bottom of the file, so the old
       `mfgSalesOrders.patch(...)` anchor lands on the one-line mount and slices nothing. */
    const h = rawSo.slice(rawSo.indexOf('export const patchMfgSalesOrderStatusHandler'));
    const guard = h.slice(0, h.indexOf('const currentVersion'));
    expect(guard).toContain('cancel_is_final');
    expect(guard).toContain("fromNorm === 'CANCELLED'");
    expect(guard).toContain('linked_ac_docno');
  });

  test('the PO reopen route refuses the same way', () => {
    const h = rawPo.slice(rawPo.indexOf("mfgPurchaseOrders.patch('/:id/reopen'"));
    const guard = h.slice(0, h.indexOf('cannot_reopen'));
    expect(guard).toContain('cancel_is_final');
    expect(guard).toContain('linked_ac_docno');
  });
});
