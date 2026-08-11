import { describe, expect, test } from 'vitest';
import rawSo from '../src/scm/routes/mfg-sales-orders.ts?raw';
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
    const tail = between(soSource, "action: 'CREATE',", 'return c.json({ docNo }, 201);');
    expect(tail).toContain('enqueueSoCreate(sb, {');
    /* A draft is the scan job's guess awaiting an operator's verdict — it does
       not belong in a live account book. It is queued when it leaves DRAFT. */
    expect(tail).toContain("if ((body as { asDraft?: unknown }).asDraft !== true) {");
    expect(between(soSource, 'post-status failed', 'Edge #B')).toContain("} else if (fromNorm === 'DRAFT') {");
  });

  test('2. PO create — queued before the 201, and NOT for a draft', () => {
    const tail = between(poSource, 'await recordPoCreate(', 'return c.json({ id: header.id, poNumber: header.po_number }, 201);');
    expect(tail).toContain('enqueuePoCreate(supabase, {');
    expect(tail).toContain('if (!asDraft) {');
    // The confirm transition is where a drafted PO becomes real.
    expect(between(poSource, "select('id, status, submitted_at')", "return c.json({ purchaseOrder: after ?? { id, status: 'SUBMITTED' } });"))
      .toContain('enqueuePoCreate(supabase, {');
  });

  test('3. SO -> DO — both the converter and an SO-linked manual DO', () => {
    const converter = between(doSource, 'Converted from Sales Order', 'return c.json({');
    expect(converter).toContain("op: 'so_to_do'");
    // A DO merged from several SOs has no AutoCount shape; it must be RECORDED.
    expect(converter).toContain('recordConvertSkipped');

    const manual = between(doSource, 'await recordDoCreate(sb,', '/* A DO = goods shipped on creation');
    expect(manual).toContain("op: 'so_to_do'");
  });

  test('4. PO -> GRN — the whole-PO receive and the per-line receive', () => {
    const wholePo = between(grnSource, 'Batch-converted from', 'const movementErrors = postRes.ok');
    expect(wholePo).toContain("op: 'po_to_gr'");
    expect(wholePo).toContain('recordConvertSkipped');

    const perLine = between(grnSource, 'Received from ${[...bucket.poNumbers]', 'const postFailReason');
    expect(perLine).toContain("op: 'po_to_gr'");
  });

  test('5. DO -> Sales Invoice', () => {
    const conv = between(siSource, 'Converted from ${distinctDoNumbers.length > 1', '/* LEAK GUARD (DRAFT)');
    expect(conv).toContain("op: 'do_to_iv'");
    expect(conv).toContain('recordConvertSkipped');
  });

  test('6. GRN -> Purchase Invoice — the whole-GRN and the per-line paths', () => {
    const wholeGrn = between(piSource, 'Converted from Goods Receipt ${g.grn_number', 'return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);');
    expect(wholeGrn).toContain("op: 'gr_to_pi'");

    const perLine = between(piSource, 'Converted from Goods Receipt ${bucket.grnNumbers', '// Consume the GRN lines');
    expect(perLine).toContain("op: 'gr_to_pi'");
    expect(perLine).toContain('recordConvertSkipped');
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
    const tail = between(grnSource, 'await recomputePoReceived(sb, lineList.map', "return c.json({ grn: data ?? { id, status: 'CANCELLED' } });");
    expect(tail).toContain('enqueueCancel(sb, {');
    expect(tail).toContain("docType: 'GR'");
  });

  test('every SO mutation path queues an edit — header, line add/edit/delete, and the variant/SKU swaps', () => {
    // Header CAS save.
    expect(between(soSource, 'header saved but edit lease was no longer ours', 'version: savedVersion,'))
      .toContain('queueAcSoEdit(c, docNo)');
    // Line add / edit / delete.
    expect(between(soSource, 'post-line-add failed', 'return c.json({ item: data }, 201);'))
      .toContain('queueAcSoEdit(c, docNo)');
    expect(between(soSource, 'post-line-patch failed', 'return c.json({ ok: true });'))
      .toContain('queueAcSoEdit(c, docNo)');
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

  test('every PO mutation path queues an edit', () => {
    expect(soSource).toBeTruthy();
    expect(between(poSource, 'header date cascade failed', 'return c.json({ purchaseOrder: data });'))
      .toContain('queueAcPoEdit(c, id)');
    expect(between(poSource, 'Line added: ${String(it.materialCode', 'return c.json({ item: data }, 201);'))
      .toContain('queueAcPoEdit(c, poId)');
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
