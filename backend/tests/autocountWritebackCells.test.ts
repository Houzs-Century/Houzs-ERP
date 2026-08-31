import { describe, expect, test } from 'vitest';
import rawSo from '../src/scm/routes/mfg-sales-orders.ts?raw';
import rawPo from '../src/scm/routes/mfg-purchase-orders.ts?raw';
import rawDo from '../src/scm/routes/delivery-orders-mfg.ts?raw';
import rawGrn from '../src/scm/routes/grns.ts?raw';
/* The GR edit wrapper moved OUT of grns.ts on 2026-08-20 (the file-size ratchet
   refused the growth, and its own message says to move new code into a module).
   It is still the "thin per-file wrapper" this file's matcher was written for —
   it just lives in its own file now, so the scan has to follow it there. Without
   this import the EDIT case reports GR unreachable while grns.ts calls it four
   times: a true property, measured through a mechanism that lost sight of it. */
import rawGrnOutbox from '../src/scm/lib/ac-grn-outbox.ts?raw';
import rawSi from '../src/scm/routes/sales-invoices.ts?raw';
import rawPi from '../src/scm/routes/purchase-invoices.ts?raw';
import rawSoAmend from '../src/scm/routes/so-amendments.ts?raw';
import rawPoAmend from '../src/scm/routes/po-amendments.ts?raw';
import rawOutbox from '../src/scm/lib/autocount-outbox.ts?raw';
import rawSiSource from '../src/scm/lib/si-autocount-source.ts?raw';
import rawWriteback from '../src/services/autocount-writeback.ts?raw';
import rawService from '../scripts/autocount-service/AcSyncService.cs?raw';

/* ERP -> AutoCount: THE CELLS THE MATRIX FOUND EMPTY.
 *
 * autocountWritebackWiring.test.ts asserts that a set of NAMED anchors still
 * carry their queue call. That is a useful regression net and a poor coverage
 * claim: a test whose name says "every SO mutation path queues an edit" while
 * its body checks seven hand-listed places will pass forever after the eighth
 * path is added, and the NAME is what the next reader trusts.
 *
 * So the tests here are built the other way round wherever the shape allows it:
 * the expected SET is DERIVED — from AcSyncService.cs, the other half of the
 * system — and compared against the set the ERP actually reaches. A document
 * type that AcSyncService can cancel or edit and the ERP cannot ask it to is a
 * failure, automatically, without anyone remembering to add a case.
 */

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const SO = lf(rawSo);
const PO = lf(rawPo);
const DO = lf(rawDo);
const GRN = lf(rawGrn);
const GRN_OUTBOX = lf(rawGrnOutbox);
const SI = lf(rawSi);
const PI = lf(rawPi);
const SO_AMEND = lf(rawSoAmend);
const PO_AMEND = lf(rawPoAmend);
const OUTBOX = lf(rawOutbox);
const SI_SOURCE = lf(rawSiSource);
const WRITEBACK = lf(rawWriteback);
const SERVICE = lf(rawService);

const ROUTERS = [SO, PO, DO, GRN, GRN_OUTBOX, SI, PI, SO_AMEND, PO_AMEND];

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

/** The doc types a C# switch in AcSyncService handles, read out of its source. */
function serviceHandles(fn: 'Cancel' | 'Edit'): string[] {
  const body = between(
    SERVICE,
    /* NAME AND PARAMETER LIST, not the return type — `Edit` stopped being `void`
       on 2026-08-31 when it began answering with the line keys it assigned
       (docs/bugs/0583-*), while `Cancel` is still void. The parameter list only
       ever appears on the DECLARATION (a call site is `Edit(p)`), so dropping
       the return type costs no precision. */
    `${fn}(Dictionary<string, object> p) {`,
    'default: throw new Exception("unsupported DocType " + type);',
  );
  return [...body.matchAll(/case "([A-Z]{2})":/g)].map((m) => m[1]).sort();
}

/** The doc types the ERP passes to a given enqueue helper, across every router. */
function erpAsksFor(helper: 'enqueueCancel' | 'enqueueEdit'): string[] {
  const found = new Set<string>();
  for (const src of ROUTERS) {
    /* Route handlers pass docType through thin per-file wrappers as often as
       inline, so both shapes count: the literal beside the call, and the literal
       inside a wrapper whose body calls the helper. */
    for (const m of src.matchAll(new RegExp(`${helper}\\([\\s\\S]{0,600}?docType: '([A-Z]{2})'`, 'g'))) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe('the ERP can reach every document type AcSyncService can', () => {
  /* THE POINT OF DERIVING THE EXPECTATION FROM THE SERVICE. Before this change
     AcSyncService could cancel all six types and edit all six; the ERP could
     cancel four and edit two. Four fully-built service code paths were
     unreachable, and nothing said so — the matrix had to be assembled by hand to
     find it. Reading the switch is what makes that discovery automatic. */
  test('CANCEL: every case in AcSyncService.Cancel() is reachable from a route', () => {
    const service = serviceHandles('Cancel');
    expect(service).toEqual(['DO', 'GR', 'IV', 'PI', 'PO', 'SO']);
    // Before this change the ERP asked for SO, PO, DO, GR — never IV or PI.
    expect(erpAsksFor('enqueueCancel')).toEqual(service);
  });

  test('EDIT: every case in AcSyncService.Edit() is reachable from a route', () => {
    const service = serviceHandles('Edit');
    expect(service).toEqual(['DO', 'GR', 'IV', 'PI', 'PO', 'SO']);
    // Before this change the ERP asked for SO and PO only — enqueueEdit's own
    // docType was typed `'SO' | 'PO'`, so the other four could not be expressed.
    expect(erpAsksFor('enqueueEdit')).toEqual(service);
  });

  test('the outbox no longer narrows the doc type below what the service accepts', () => {
    // The exact narrowing that made four of the six edits inexpressible.
    expect(OUTBOX).not.toContain("docType: 'SO' | 'PO';");
    expect(OUTBOX).toContain('docType: AcDocType;');
  });
});

describe('the four downstream document types queue an edit on every line and header mutation', () => {
  /* One case per router, each anchored on the route's OWN tail rather than on a
     shared comment, so a moved handler fails loudly instead of matching a
     neighbour's block. */
  test('DO — header PATCH and line add / edit / delete', () => {
    expect(between(DO, "deliveryOrdersMfg.patch('/:id',", 'return c.json({\n    ok: true,')).toContain('queueAcDoEdit(c, id)');
    /* Anchored on the DECLARATION, not the registration: the add-line handler
       became a named export (2026-08-23) so the outbound-category suite could
       drive it, which moved `deliveryOrdersMfg.post('/:id/items',` to a one-line
       registration BELOW the body. The pin still spans the same handler. */
    expect(between(DO, 'export const addDeliveryOrderItemHandler', 'return c.json({ item: data }, 201);')).toContain('queueAcDoEdit(c, id)');
    expect(between(DO, "deliveryOrdersMfg.patch('/:id/items/:itemId',", 'return c.json({ ok: true });')).toContain('queueAcDoEdit(c, id)');
    expect(between(DO, "deliveryOrdersMfg.delete('/:id/items/:itemId',", 'return c.json({ ok: true });')).toContain('queueAcDoEdit(c, id, retire)');
  });

  /* The pinned shapes carry `sb` since 2026-08-20: the outbox helper now takes
     its client explicitly, so a caller inside a PG transaction can hand it the
     transactional one. Pinning the ARGUMENTS, not just the name, is what makes
     that visible here — a signature change cannot slip past this file. */
  test('GRN — header PATCH and line add / edit / delete', () => {
    expect(between(GRN, "grns.patch('/:id',", 'return c.json({ grn: data });')).toContain('queueAcGrnEdit(c, sb, id)');
    expect(between(GRN, "grns.post('/:id/items',", 'return c.json({ item: data }, 201);')).toContain('queueAcGrnEdit(c, sb, grnId)');
    expect(between(GRN, "grns.patch('/:id/items/:itemId',", 'return c.json({ ok: true });')).toContain('queueAcGrnEdit(c, sb, grnId)');
    expect(between(GRN, "grns.delete('/:id/items/:itemId',", 'return c.body(null, 204);')).toContain('queueAcGrnEdit(c, sb, grnId, retire)');
  });

  test('Sales Invoice — header PATCH and line add / edit / delete', () => {
    expect(between(SI, "salesInvoices.patch('/:id',", 'return c.json({ ok: true, id });')).toContain('queueAcSiEdit(c, id)');
    /* Anchored on the DECLARATION, not the registration: this handler was extracted
     as a named export in 2026-08-19's company-scope fix so a test could mount it,
     which moved `salesInvoices.post('/:id/items', ...)` below the body. */
  expect(between(SI, 'export const appendSalesInvoiceItemHandler =', 'return c.json(withPriceWarnings({ item: data }, priceWarnings), 201);')).toContain('queueAcSiEdit(c, id)');
    expect(between(SI, "salesInvoices.patch('/:id/items/:itemId',", 'return c.json({ ok: true });')).toContain('queueAcSiEdit(c, id)');
    expect(between(SI, "salesInvoices.delete('/:id/items/:itemId',", 'return c.json({ ok: true });')).toContain('queueAcSiEdit(c, id, retire)');
  });

  test('Purchase Invoice — header PATCH and line add / edit / delete', () => {
    expect(between(PI, "purchaseInvoices.patch('/:id',", 'return c.json({ purchaseInvoice: data });')).toContain('queueAcPiEdit(c, id)');
    expect(between(PI, "purchaseInvoices.post('/:id/items',", 'return c.json({ item: data }, 201);')).toContain('queueAcPiEdit(c, piId)');
    expect(between(PI, "purchaseInvoices.patch('/:id/items/:itemId',", 'return c.json({ ok: true });')).toContain('queueAcPiEdit(c, piId)');
    expect(between(PI, "purchaseInvoices.delete('/:id/items/:itemId',", 'return c.body(null, 204);')).toContain('queueAcPiEdit(c, piId, retire)');
  });
});

describe('the SO and PO mutation paths the named-anchor test did not cover', () => {
  test('SO price override — the admin side-door that writes unit_price_sen', () => {
    /* UnitPrice IS an AutoCount field. This route was the one price path that
       does not go through PATCH /:docNo/items/:itemId, so the ERP and the
       account book quoted different money for the same line. */
    const tail = between(SO, "mfgSalesOrders.post('/:docNo/items/:itemId/override'", 'return c.json({ ok: true, itemId, newPrice });');
    expect(tail).toContain('queueAcSoEdit(c, docNo)');
  });

  test('SO amendment apply — the sanctioned way to change a CONFIRMED order', () => {
    const tail = between(SO_AMEND, 'applied = await applySoAmendment(', 'poFollowUps: poFollowUps.followUps,');
    expect(tail).toContain('enqueueEdit(sb, {');
    expect(tail).toContain("docType: 'SO'");
  });

  test('PO amendment apply — both the manual engine and the SO-sourced re-derive', () => {
    const tail = between(PO_AMEND, 'const applied = await applyPoAmendment(', 'return c.json({ amendment: updated, revision: appliedRevision');
    expect(tail).toContain('enqueueEdit(sb, {');
    expect(tail).toContain("docType: 'PO'");
  });

  test('PO bulk supplier-date — one edit per PO that actually moved, inside the loop', () => {
    const tail = between(PO, "mfgPurchaseOrders.post('/bulk-supplier-date'", 'return c.json({ slot, date, applyToLines, updated, skipped });');
    expect(tail).toContain('queueAcPoEdit(c, id)');
    /* Inside the loop, not after it: the route skips POs that are missing,
       downstream-locked or failed to write, and those must queue nothing. */
    expect(tail.indexOf('queueAcPoEdit(c, id)')).toBeLessThan(tail.indexOf('updated.push({ id, poNumber });'));
  });

  test('PO convert-from-SO — appending SO lines to an existing PO is an edit', () => {
    const tail = between(PO, "mfgPurchaseOrders.post('/:id/convert-from-so'", 'sourceDocNo: soDocNo,');
    /* The rows it just inserted are DECLARED as new (2026-08-31) — without that
       fourth argument the append is refused as a document full of keyless lines,
       which is what it did until then. */
    expect(tail).toContain('queueAcPoEdit(c, poId, [], ((inserted ?? [])');
  });

  test('Sales Invoice partial transfer — folding a second DO into an existing invoice', () => {
    /* Anchored on the HANDLER's declaration, not on its route registration.
       The handler was extracted to a named export on 2026-08-13 so the
       company-scope tests could mount it past supabaseAuth, which moves
       `salesInvoices.post('/:id/items/from-do/:doId', ...)` BELOW the body —
       and a start anchor that now sits after the end anchor makes `between()`
       return -1, i.e. the test fails on a rename rather than on a regression.
       The declaration is where the body is, so it is the stable anchor.
       Sibling handlers extracted the same way (postStockTakeHandler,
       patchSalesInvoiceStatusHandler) are anchored this way too. */
    const tail = between(SI, 'export const appendDoLinesToSalesInvoiceHandler', 'return c.json({ ok: true, added: rows.length }, 201);');
    expect(tail).toContain('queueAcSiEdit(c, id)');
  });
});

describe('the create-side holes', () => {
  test('SO -> PO conversion queues a PO create — the MRP agent and /from-sos both ride it', () => {
    /* The largest create-side hole: convertSosToPosCore creates the PO, records
       the audit row, and used to queue nothing — and because it writes
       'SUBMITTED' directly whenever a warehouse resolves, PATCH /:id/confirm
       never fired as a backstop either. */
    const tail = between(PO, 'Raised from Sales Order${bucket.soDocNos.size === 1', 'created.push({ id: header.id, poNumber: header.po_number');
    expect(tail).toContain('enqueuePoCreate(supabase, {');
    /* Gated on the status LITERAL that was inserted, not on `asDraft` — a bucket
       whose SO line resolved no warehouse is forced to DRAFT by a second rule
       that `asDraft` does not describe. */
    expect(tail).toContain("headerPayload.status === 'DRAFT' ? [] :");
  });

  test('a document AutoCount cannot hold is RECORDED, not dropped', () => {
    /* AutoCount builds a DO / GRN / Invoice only by transferring a source
       document's lines, so a parentless one can never exist there. That is a
       permanent shape mismatch — and a permanent divergence that nothing writes
       down is one nothing can find. */
    expect(between(DO, "if ((body.soDocNo as string | undefined) ?? null) {", '/* A DO = goods shipped on creation'))
      .toContain('recordParentlessCreate(sb, {');
    expect(between(GRN, 'await recordGrnCreate(sb,', 'const movementErrors = postRes && postRes.ok'))
      .toContain('recordParentlessCreate(sb, {');
    /* SI DELEGATES, because it is the one of the four that has to CHECK first.
       POST /sales-invoices accepts a source delivery order on both halves of
       the document (`deliveryOrderId` on the header, `doItemId` per line), so
       the unconditional call that used to sit here asserted a fact it never
       tested and filed every desktop from-DO invoice as ERP-only. The record
       still exists — one file down, on the branch that established it. */
    expect(between(SI, 'await recordSiCreate(sb,', '/* LEAK GUARD (DRAFT) — a DRAFT SI must NOT post'))
      .toContain('recordSiAutoCountSource(sb, {');
    expect(between(PI, 'await recordPiCreate(sb,', '/* LEAK GUARD (DRAFT) — a DRAFT PI commits nothing'))
      .toContain('recordParentlessCreate(sb, {');
  });

  test('the SI record is CONDITIONAL — it sits on the branch where no line has a source', () => {
    /* The defect was never the record; it was an unconditional call claiming
       "no source Delivery Order" beside a handler that accepts one. An anchor
       on the branch is what stops it becoming unconditional again. */
    const noSource = between(SI_SOURCE, 'if (doIds.size === 0) {', "return 'parentless';");
    expect(noSource).toContain('recordParentlessCreate(sb, {');
    // And the other side of the same decision: a real single source is QUEUED.
    expect(SI_SOURCE).toContain("op: 'do_to_iv'");
    expect(SI_SOURCE).toContain('enqueueConvert(sb, {');
  });

  test('the parentless-create record rides an op the outbox CHECK constraint admits', () => {
    /* 0277 constrains op to the eight routes AcSyncService serves. There is no
       ninth for "a create that cannot happen", so the record is filed under the
       conversion that would have produced the document. */
    const helper = between(OUTBOX, 'export async function recordParentlessCreate(', '\n}\n');
    expect(helper).toContain("DO: 'so_to_do', GR: 'po_to_gr', IV: 'do_to_iv', PI: 'gr_to_pi',");
    expect(helper).toContain('recordConvertSkipped(sb, {');
  });
});

describe('a wrong document number is worse than a blank', () => {
  /* MEASURED ON PRODUCTION 2026-08-11 by check-cancel-parity.mjs section 4:
     "GR: 291 linked | ... | linked to a document not in the book: 291".
     Every linked GRN carries its SOURCE PO's AutoCount number in
     linked_ac_docno — HC-GRN-000001 -> PO-000136 — because that is what the
     cutover wrote. The drain resolves a cancel's and an edit's DocNo from that
     column, so without a guard the ERP asks a LIVE account book to cancel
     "GR PO-000136". The refusal must be WIRED, not merely defined: the guard
     existed as an unreferenced function and the two call sites did not exist. */
  const CANCEL_BODY = between(OUTBOX, 'export async function enqueueCancel(', '\n}\n');
  const EDIT_BODY = between(OUTBOX, 'export async function enqueueEdit(', '\n}\n');

  test('the GRN mislink guard is CALLED from enqueueCancel, not just defined', () => {
    expect(CANCEL_BODY).toContain('grnLinkIsReallyAPo(sb, opts.docId)');
    // Refused as a visible 'skipped' row, never dropped and never sent.
    expect(CANCEL_BODY).toContain("status: 'skipped'");
    expect(CANCEL_BODY).toContain('refused to cancel in AutoCount:');
  });

  test('the GRN mislink guard is CALLED from enqueueEdit too', () => {
    expect(EDIT_BODY).toContain('grnLinkIsReallyAPo(sb, opts.docId)');
    expect(EDIT_BODY).toContain('refused to edit in AutoCount:');
  });

  test('the guard tests MEMBERSHIP in the PO table, not a number prefix', () => {
    /* AutoCount's numbering is not reliably type-prefixed in this book, so a
       "starts with PO-" heuristic would both miss and over-match. The question
       asked is whether a purchase order claims this same AutoCount number. */
    const guard = between(OUTBOX, 'async function grnLinkIsReallyAPo(', '\n}\n');
    expect(guard).toContain("from('purchase_orders')");
    expect(guard).toContain("eq('linked_ac_docno', link)");
    /* It must NOT invent a replacement from linked_ac_grn_docnos: a PO received
       in several deliveries has several, and none of them is "this ERP GRN". */
    expect(guard).not.toContain('linked_ac_grn_docnos[');
  });
});

describe('an edit must be an edit, never a delete-and-recreate', () => {
  test('no route reaches for a create route to express a change', () => {
    /* Hard rule 1: nothing is ever deleted. Implementing an edit as
       delete-then-create would also destroy AutoCount's own DocTransfer links
       and its audit trail, which is worse than the ERP-side data loss. */
    for (const src of ROUTERS) {
      expect(src).not.toMatch(/enqueueCancel\([\s\S]{0,400}?enqueueSoCreate\(/);
      expect(src).not.toMatch(/enqueueCancel\([\s\S]{0,400}?enqueuePoCreate\(/);
    }
  });

  test('a key the ERP does not own is OMITTED, never sent as null', () => {
    /* AcSyncService applies only the keys PRESENT (h.ContainsKey), and its Str
       helper turns a present-but-null key into "". So {"Location": null} does
       not mean "leave it alone" — it BLANKS the account book's value. */
    const service = between(SERVICE, 'var h = Dict(p, "Header");', 'foreach (var od in List(p, "Lines"))');
    expect(service).toContain('if (!h.ContainsKey(key)) continue;');
    // Same gate on the LINE loop — this is the one that silently blanked Location.
    expect(SERVICE).toContain('if (it.ContainsKey("Location"))    Set(() => d.Location = Str(it, "Location"));');
    // And the ERP side now omits the key instead of sending null.
    expect(lf(rawWriteback)).toContain('if (location) d.Location = location;');
    expect(lf(rawWriteback)).not.toContain('Location: l.location ? mapOrPassthrough');
  });
});

/* ── LINE REMOVAL REACHES AUTOCOUNT ON ALL SIX ───────────────────────────────
   The failure mode is silence, which is why this is derived from the six DELETE
   handlers rather than from a hand-written list. /edit applies only the lines it
   is GIVEN (AcSyncService.cs, its Lines loop): a row the ERP deleted is simply
   absent from the recomposed payload, so without an explicit retirement the
   account book keeps the line LIVE, outstanding, and transferable into a later
   DO or GRN. Every line-DELETE route must therefore read the row's AutoCount key
   before destroying it and hand it to the edit. */
describe('every line-DELETE route retires the line in AutoCount', () => {
  const DELETES: Array<[string, string, string, string, string]> = [
    ['SO',  SO,  "mfgSalesOrders.delete('/:docNo/items/:itemId',",      'return c.body(null, 204);', 'mfg_sales_order_items'],
    ['PO',  PO,  "mfgPurchaseOrders.delete('/:id/items/:itemId',",      'return c.body(null, 204);', 'purchase_order_items'],
    ['DO',  DO,  "deliveryOrdersMfg.delete('/:id/items/:itemId',",      'return c.json({ ok: true });', 'delivery_order_items'],
    ['GR',  GRN, "grns.delete('/:id/items/:itemId',",                   'return c.body(null, 204);', 'grn_items'],
    ['IV',  SI,  "salesInvoices.delete('/:id/items/:itemId',",          'return c.json({ ok: true });', 'sales_invoice_items'],
    ['PI',  PI,  "purchaseInvoices.delete('/:id/items/:itemId',",       'return c.body(null, 204);', 'purchase_invoice_items'],
  ];

  test.each(DELETES)('%s — the key is read BEFORE the row is destroyed', (_t, src, start, end, table) => {
    const body = between(src, start, end);
    expect(body).toContain(`retiredLineOf(sb, '${table}', itemId)`);
    /* Order is the whole property: after the delete the row is gone and its
       DtlKey with it, so the read has to come first. */
    expect(body.indexOf('retiredLineOf')).toBeLessThan(body.indexOf(`from('${table}').delete()`) >= 0
      ? body.indexOf(`from('${table}').delete()`)
      : body.indexOf('.delete()'));
  });

  test('the composer expresses a retirement, and refuses one it cannot name', () => {
    // Retire is what AcSyncService turns into Qty = 0 + Transferable = false.
    expect(WRITEBACK).toContain('Retire: true');
    expect(SERVICE).toContain('if (Bool(it, "Retire"))');
    // A cancelled line with no key is refused rather than silently dropped.
    expect(WRITEBACK).toContain('A cancelled line with no key cannot be retired in AutoCount');
  });

  test('a conversion names the lines it took, so a partial shipment stays partial', () => {
    // Omitting DtlKeys makes AcSyncService transfer every outstanding line.
    expect(OUTBOX).toContain('DtlKeys: source.keys');
    expect(SERVICE).toContain('var given = List(p, "DtlKeys");');
  });
});
