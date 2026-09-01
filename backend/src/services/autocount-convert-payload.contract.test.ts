// ----------------------------------------------------------------------------
// THE CONVERSION PAYLOAD CONTRACT — one master, two projections, and the guard.
//
// SPLIT OUT OF autocount-writeback.contract.test.ts on 2026-08-20, when that
// file reached the 2,000-line cap: #2523 and this change both landed large
// blocks in it on the same day. Same seam autocount-convert-lines.ts was cut on
// two days earlier, and for the same reason — this is ONE idea, and the rest of
// the payload contract neither knows nor needs how it answers.
//
// WHAT IT PINS, in one sentence: a downstream document describes itself ONCE
// (`AcDownstreamSpec.facts`), both routes are PROJECTIONS of that description,
// and a field added to it either reaches a route or fails the build by name.
//
// That is the property, not any single field. The hole it closes was patched
// twice on `/so-to-po`, one field at a time, each after a live document failed,
// and five fields were still missing after the second patch — because there
// were TWO hand-written descriptions of one document and nothing compared them.
//
// It reads AcSyncService.cs at build time via ?raw, exactly as the parent file
// does, because the two programs are in different languages and repositories at
// run time and `Str(p, "X")` turns an absent key into "" rather than an error.
//
// No AutoCount, no network, no database.
// ----------------------------------------------------------------------------
import { describe, expect, test, beforeEach } from 'vitest';
import rawAcSync from '../../scripts/autocount-service/AcSyncService.cs?raw';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { enqueueConvert, dispatchOne, type AcOutboxRow } from '../scm/lib/autocount-outbox';
import { resetWritebackFlagCache } from '../scm/lib/autocount-writeback-flag';
/* The ONE master each downstream document describes itself with, and the two
   key sets the routes project it onto. Imported rather than restated, so this
   file cannot hold a second opinion about the shape it is checking. */
import {
  DOWNSTREAM,
  CONVERT_TARGET,
  AC_EDIT_HEADER_KEYS,
  AC_TRANSFER_HEADER_KEYS,
  downstreamTransferHeader,
  downstreamNotCarried,
} from '../scm/lib/autocount-convert-lines';

/* ?raw hands back WORKING TREE bytes, which on Windows are CRLF. Normalise, or
   every anchor here means something different depending on whose machine ran. */
const acSyncSource = rawAcSync.replace(/\r\n/g, '\n');

/** A method body, sliced out of the C# by two anchors that exist in the file. */
function slice(from: string, to: string): string {
  const a = acSyncSource.indexOf(from);
  expect(a, `AcSyncService.cs anchor missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = acSyncSource.indexOf(to, a + from.length);
  expect(b, `AcSyncService.cs anchor missing after ${from}: ${to}`).toBeGreaterThan(a);
  return acSyncSource.slice(a, b);
}

const CS_CONVERT = slice('static string Convert_(', '/* OVER-TRANSFER:');
const CS_SALES_HEADER = slice('static void SalesHeader(', 'static void PurchaseHeader(');
const CS_PURCHASE_HEADER = slice('static void PurchaseHeader(', '/* Source line keys');
/* The signature changed on 2026-08-31 — /edit now RETURNS the document's line
   keys when it added a line, so the ERP can store them (docs/bugs/0583-*). The
   anchor follows the name, not the return type. */
const CS_EDIT = slice('Edit(Dictionary<string, object> p)', '// ── helpers');

/** Keys read off a JSON object in C#: Str(p,"X") / Dec / Date / Dict / List. */
const keysRead = (body: string, bag: string): string[] => {
  const out = new Set<string>();
  const re = new RegExp(`(?:Str|Dec|Date|Dict|List)\\(\\s*${bag}\\s*,\\s*"([A-Za-z0-9_]+)"`, 'g');
  for (const m of body.matchAll(re)) out.add(m[1]);
  for (const m of body.matchAll(new RegExp(`${bag}\\.ContainsKey\\("([A-Za-z0-9_]+)"\\)`, 'g'))) out.add(m[1]);
  return [...out].sort();
};
const headerKeys = (body: string, bag = 'p') => keysRead(body, bag);

/** The header allow-list /edit's reflection loop iterates — the only header
 *  fields it will ever apply. Anything outside it is read and dropped. */
const csEditHeaderAllowList = (): string[] => {
  const block = CS_EDIT.slice(CS_EDIT.indexOf('new string[] {'), CS_EDIT.indexOf('}) {'));
  return [...block.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort();
};

/* ── the fixture ────────────────────────────────────────────────────────────
   EVERY HEADER FACT IS FILLED IN, and that is the point of it. The four
   downstream fixtures in the parent file were `{ id, number, linked_ac_docno }`
   and nothing else — a fixture that agrees with the bug, because a payload
   cannot be caught dropping a date, a reference or a supplier's document number
   when the row it reads has none of them. */
const SUPPLIER = { id: 'supplier-uuid-1', code: '400-T001', name: 'Trial Supplier Sdn Bhd', company_id: 1 };

const seeded = () => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: 'all' }],
  autocount_outbox: [],
  suppliers: [{ ...SUPPLIER }],
  /* The GRN's own `warehouse_id` is a uuid and AutoCount's `dbo.Location` is
     keyed by the short code, so the hop needs this row. */
  warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL Warehouse' }],
  mfg_sales_orders: [{ doc_no: 'SO-2608-011', company_id: 1, linked_ac_docno: null }],
  purchase_orders: [{ id: 'po-uuid-1', po_number: 'PO-2608-004', company_id: 1, supplier_id: 'supplier-uuid-1', linked_ac_docno: null }],
  delivery_orders: [{
    id: 'do-uuid-1', do_number: 'DO-2608-009', do_date: '2026-08-19',
    debtor_name: 'Trial Customer Sdn Bhd', ref: 'CUST-REF-77', phone: '0123456789',
    note: 'Leave at the guardhouse', linked_ac_docno: null,
  }],
  grns: [{
    id: 'grn-uuid-1', grn_number: 'GRN-2608-003', linked_ac_docno: null,
    supplier_id: 'supplier-uuid-1', received_at: '2026-08-18', warehouse_id: 'wh-kl',
    delivery_note_ref: 'SUPP-DN-4412', notes: 'Two cartons dented, accepted',
  }],
  sales_invoices: [{
    id: 'si-uuid-1', invoice_number: 'SI-2608-002', linked_ac_docno: null,
    invoice_date: '2026-08-19', debtor_name: 'Trial Customer Sdn Bhd',
    ref: 'CUST-REF-77', phone: '0123456789', note: 'Billed after delivery',
  }],
  purchase_invoices: [{
    id: 'pi-uuid-1', invoice_number: 'PI-2608-002', linked_ac_docno: null,
    invoice_date: '2026-08-19', supplier_invoice_ref: 'SUPP-INV-9931',
    notes: 'Freight billed separately',
  }],
} as Record<string, Row[]>);

const ENV = { AC_SYNC_URL: 'http://ac-test.invalid:8900', AC_SYNC_KEY: 'not-a-real-key' } as never;

/** Drain one queued row and hand back the JSON body that went on the wire. */
async function wireBody(sb: any, index = 0): Promise<Record<string, unknown>> {
  const row = sb.tables.autocount_outbox[index] as AcOutboxRow;
  expect(row, 'nothing was queued').toBeTruthy();
  let sent: unknown = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true, docNo: 'AC-1' }), { status: 200 });
  }) as never;
  await dispatchOne(ENV, sb, { ...row, id: (row as any).id ?? 'row-1' }, fetchImpl);
  return sent as Record<string, unknown>;
}

beforeEach(() => resetWritebackFlagCache());

/* ── THE STRUCTURAL GUARD ────────────────────────────────────────────────
   THIS IS THE TEST THAT HAS TO SURVIVE, more than any single field below.

   The hole this closes was patched twice on `/so-to-po`, one field at a time,
   each time after a live document failed, and five fields were still missing
   after the second patch. The reason a third patch would have failed the same
   way is that there were TWO hand-written descriptions of one document and
   nothing compared them. `AcDownstreamSpec.facts` is now the only one, and
   the routes are projections of it — so the only way to reintroduce the bug
   is to add a fact that no route can carry, and these three tests are what
   make that fail loudly instead of silently. */
describe('a header fact reaches a route, or the build says which one does not', () => {
  /* One row per type carrying a value for EVERY fact, so nothing is missed
     for being blank. Values are shaped like the real columns, not empty
     strings: `present()` drops a blank, which would hide the very key under
     test. */
  const FULL_ROW: Record<'DO' | 'GR' | 'IV' | 'PI', Record<string, unknown>> = {
    DO: {
      id: 'x', do_number: 'DO-1', do_date: '2026-08-19', debtor_name: 'N',
      ref: 'R', phone: 'P', note: 'T',
    },
    GR: {
      id: 'x', grn_number: 'GR-1', received_at: '2026-08-18', warehouse_id: 'wh-kl',
      delivery_note_ref: 'R', notes: 'T',
    },
    IV: {
      id: 'x', invoice_number: 'SI-1', invoice_date: '2026-08-19', debtor_name: 'N',
      ref: 'R', phone: 'P', note: 'T',
    },
    PI: {
      id: 'x', invoice_number: 'PI-1', invoice_date: '2026-08-19',
      supplier_invoice_ref: 'R', notes: 'T',
    },
  };
  const TYPES = ['DO', 'GR', 'IV', 'PI'] as const;

  test('every fact a downstream spec states can be applied by SOME route', () => {
    /* THE GUARD. Add a field to a spec's `facts` and it must land somewhere:
       on the transfer, on /edit, or on both. A fact that lands nowhere is a
       value the ERP believes it is sending and AutoCount never receives —
       which is precisely what `Agent` would have been had it been added to
       the /so-to-po payload, because `PurchaseHeader` had no Agent slot. */
    for (const t of TYPES) {
      const reachable = new Set([...AC_EDIT_HEADER_KEYS, ...AC_TRANSFER_HEADER_KEYS[t]]);
      const orphans = Object.keys(DOWNSTREAM[t].facts(FULL_ROW[t], { locationCode: 'KL' }))
        .filter((k) => !reachable.has(k));
      expect(
        orphans,
        `${t}: these header facts are stated by the ERP and applied by NO route — not the `
        + `conversion (SalesHeader / PurchaseHeader) and not /edit's allow-list. Give the `
        + `service a slot for them or take them out: ${orphans.join(', ')}`,
      ).toEqual([]);
    }
  });

  test('neither key set claims a key AcSyncService.cs does not read', () => {
    /* SUBSET, NOT EQUALITY, and deliberately. The service may grow a slot the
       ERP has nothing to put in — `Agent` on `PurchaseHeader` is one landing
       on a sibling branch as this is written, and `DisplayTerm` has always
       been one. An equality here would go red on the OTHER half of the same
       fix. The direction that costs a live account book is this one: the ERP
       sending a key the route discards. */
    const arm: Record<'DO' | 'GR' | 'IV' | 'PI', Set<string>> = {
      DO: new Set(headerKeys(CS_SALES_HEADER)),
      IV: new Set(headerKeys(CS_SALES_HEADER)),
      GR: new Set([...headerKeys(CS_PURCHASE_HEADER), 'SupplierDONo']),
      PI: new Set([...headerKeys(CS_PURCHASE_HEADER), 'SupplierInvoiceNo']),
    };
    for (const t of TYPES) {
      const unread = AC_TRANSFER_HEADER_KEYS[t].filter((k) => !arm[t].has(k));
      expect(unread, `${t}: AC_TRANSFER_HEADER_KEYS names keys the arm never reads: ${unread.join(', ')}`)
        .toEqual([]);
    }
    const editAllowed = new Set(csEditHeaderAllowList());
    const unread = AC_EDIT_HEADER_KEYS.filter((k) => !editAllowed.has(k));
    expect(unread, `AC_EDIT_HEADER_KEYS names keys /edit drops: ${unread.join(', ')}`).toEqual([]);

    /* The two arm-only assignments are on the arm they are claimed for, and
       they are UNCONDITIONAL — which is what makes not sending them
       destructive rather than merely incomplete. */
    expect(CS_CONVERT).toContain('Set(() => doc.SupplierDONo = Str(p, "SupplierDONo"));');
    expect(CS_CONVERT).toContain('Set(() => doc.SupplierInvoiceNo = Str(p, "SupplierInvoiceNo"));');
  });

  test('a fact the route cannot carry is REPORTED, not dropped in silence', () => {
    /* Two silences, two sentences — see `downstreamNotCarried`. A complete
       row reports nothing; a blank column reports "the ERP has none". */
    for (const t of TYPES) {
      expect(downstreamNotCarried(t, FULL_ROW[t], { locationCode: 'KL' }), `${t} complete`).toEqual([]);
    }
    /* The GRN with no supplier delivery note and no warehouse: two facts the
       route COULD carry and the ERP has neither of. */
    const bare = { id: 'x', grn_number: 'GR-1', received_at: '2026-08-18' };
    expect(downstreamNotCarried('GR', bare).sort()).toEqual([
      'Description: the ERP document has none, so AutoCount keeps its own',
      'PurchaseLocation: the ERP document has none, so AutoCount keeps its own',
      'Ref: the ERP document has none, so AutoCount keeps its own',
      'SupplierDONo: the ERP document has none, so AutoCount keeps its own',
    ]);
  });
});

describe('the four conversions carry the whole document', () => {
  /* ── THE WHOLE DOCUMENT, ON EVERY CONVERSION ─────────────────────────────
     THE FOUR TESTS THAT USED TO BE HERE WERE `test.skip`, AND THAT IS WHY THIS
     WENT UNNOTICED FOR A WEEK. Each asserted the payload as
     `{ FromDocNo, DocDate: null, Ref: null }` with `// D4` beside it — a
     description of the bug, checked in, switched off, so nothing failed while
     `DocNo`, `DebtorCode`, `CreditorCode` and `DtlKeys` were added around them
     and D4's own evidence rotted (it still cited `autocount-outbox.ts:254`, four
     hundred lines from where `enqueueConvert` now lives).

     WHAT REPLACES THEM IS NOT A LIST OF FIELDS. It is the parity itself: the
     payload is held up against the document's OWN master — `spec.facts`,
     projected onto the keys AcSyncService actually applies on this route — so a
     fact added to a spec is asserted on the transfer the day it is added, and
     nobody has to remember to extend a fixture. That is the difference between
     this and the two one-field patches `/so-to-po` got.

     THE CASES ARE DERIVED FROM `CONVERT_TARGET`, so a fifth conversion is
     covered by existing on that map — the same rule `SALES_CONVERSION` follows
     one file over. */
  const CONVERSION_CASES = [
    {
      op: 'so_to_do' as const, docType: 'DO' as const,
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
      docNo: 'DO-2608-009', table: 'delivery_orders',
    },
    {
      op: 'po_to_gr' as const, docType: 'GR' as const,
      from: { table: 'purchase_orders', keyCol: 'id', key: 'po-uuid-1' },
      to: { table: 'grns', keyCol: 'id', key: 'grn-uuid-1' },
      docNo: 'GRN-2608-003', table: 'grns',
    },
    {
      op: 'do_to_iv' as const, docType: 'IV' as const,
      from: { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
      to: { table: 'sales_invoices', keyCol: 'id', key: 'si-uuid-1' },
      docNo: 'SI-2608-002', table: 'sales_invoices',
    },
    {
      op: 'gr_to_pi' as const, docType: 'PI' as const,
      from: { table: 'grns', keyCol: 'id', key: 'grn-uuid-1' },
      to: { table: 'purchase_invoices', keyCol: 'id', key: 'pi-uuid-1' },
      docNo: 'PI-2608-002', table: 'purchase_invoices',
    },
  ];

  test('every conversion is offered as a case here', () => {
    /* The list above is hand-written because each case needs a source and a
       target fixture; this is what stops it going stale when a fifth
       conversion is added to CONVERT_TARGET. */
    expect(CONVERSION_CASES.map((c) => c.op).sort()).toEqual(Object.keys(CONVERT_TARGET).sort());
    expect(CONVERSION_CASES.map((c) => c.docType).sort())
      .toEqual(CONVERSION_CASES.map((c) => CONVERT_TARGET[c.op]).sort());
  });

  test.each(CONVERSION_CASES)(
    '$op carries every header fact this route can apply',
    async (kase) => {
      const sb = seeded();
      sb.tables[kase.from.table][0].linked_ac_docno = 'AC-PARENT-1';
      expect((await enqueueConvert(sb as never, {
        companyId: 1, op: kase.op, from: kase.from as never, to: kase.to as never,
        docType: kase.docType, docNo: kase.docNo, docId: kase.to.key,
      })).queued).toBe(true);
      const body = await wireBody(sb);

      const h = sb.tables[kase.table][0] as Record<string, unknown>;
      /* The warehouse code the enqueue is expected to resolve for itself —
         `scm.grns.warehouse_id` is a uuid and `dbo.Location` is keyed by the
         code, so the fixture's `wh-kl` row is the hop. */
      const want = downstreamTransferHeader(kase.docType, h, { locationCode: 'KL' });

      const missing = Object.keys(want).filter((k) => !(k in body));
      expect(
        missing,
        `${kase.op}: the ERP holds these header facts, AcSyncService applies every one of them on `
        + `this route, and the transfer payload carries none of them: ${missing.join(', ')}`,
      ).toEqual([]);
      /* KEYS ARE NOT ENOUGH — a key present with the wrong value is the failure
         that put PO-009968 in the book. */
      for (const k of Object.keys(want)) {
        expect(body[k], `${kase.op}: ${k} on the wire`).toBe(want[k]);
      }
    },
  );

  test.each(CONVERSION_CASES)(
    '$op sends no header key AcSyncService would silently discard',
    async (kase) => {
      const sb = seeded();
      sb.tables[kase.from.table][0].linked_ac_docno = 'AC-PARENT-1';
      await enqueueConvert(sb as never, {
        companyId: 1, op: kase.op, from: kase.from as never, to: kase.to as never,
        docType: kase.docType, docNo: kase.docNo, docId: kase.to.key,
      });
      const body = await wireBody(sb);
      /* The keys that are NOT header fields: the transfer's own arguments and
         the account, all read by Convert_ itself rather than by the two header
         appliers. */
      const TRANSFER_ARGS = new Set([
        'FromDocNo', 'FromDocNos', 'DtlKeys', 'KeysByDoc', 'Details',
        'DebtorCode', 'DebtorName', 'CreditorCode', 'CreditorName',
      ]);
      const applied = new Set<string>([
        ...AC_TRANSFER_HEADER_KEYS[kase.docType],
        ...headerKeys(CS_CONVERT),
      ]);
      const dropped = Object.keys(body).filter((k) => !TRANSFER_ARGS.has(k) && !applied.has(k));
      expect(
        dropped,
        `${kase.op}: these keys go on the wire and neither Convert_ nor the header applier reads `
        + `them, so they are composed, stored, POSTed and thrown away: ${dropped.join(', ')}`,
      ).toEqual([]);
    },
  );
});
