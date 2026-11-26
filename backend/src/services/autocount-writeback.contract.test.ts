import { describe, expect, test, beforeEach } from 'vitest';
import rawAcSync from '../../scripts/autocount-service/AcSyncService.cs?raw';
import selfSource from './autocount-writeback.contract.test.ts?raw';
import rawScmSchema from '../../scripts/scm-schema/2990s-full-schema.sql?raw';
import trialPayloads from '../../scripts/autocount-service/trial-payloads.json';

import {
  enqueueSoCreate,
  enqueuePoCreate,
  enqueueConvert,
  enqueueCancel,
  enqueueEdit,
  dispatchOne,
  type AcOutboxRow,
} from '../scm/lib/autocount-outbox';
import { AC_DEBTOR_CODE } from './autocount-writeback';
import { resetWritebackFlagCache } from '../scm/lib/autocount-writeback-flag';
import { parsePgrestInList } from '../scm/lib/pgrest-in-list';

const acSyncSource = rawAcSync.replace(/\r\n/g, '\n');
const scmSchemaSql = rawScmSchema.replace(/\r\n/g, '\n');


function slice(from: string, to: string): string {
  const a = acSyncSource.indexOf(from);
  expect(a, `AcSyncService.cs anchor missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = acSyncSource.indexOf(to, a + from.length);
  expect(b, `AcSyncService.cs anchor missing after ${from}: ${to}`).toBeGreaterThan(a);
  return acSyncSource.slice(a, b);
}

const keysRead = (body: string, bag: string): string[] => {
  const out = new Set<string>();
  const re = new RegExp(`(?:Str|Dec|Date|Dict|List)\\(\\s*${bag}\\s*,\\s*"([A-Za-z0-9_]+)"`, 'g');
  for (const m of body.matchAll(re)) out.add(m[1]);
  for (const m of body.matchAll(new RegExp(`${bag}\\.ContainsKey\\("([A-Za-z0-9_]+)"\\)`, 'g'))) out.add(m[1]);
  for (const m of body.matchAll(new RegExp(`${bag}\\["([A-Za-z0-9_]+)"\\]`, 'g'))) out.add(m[1]);
  return [...out].sort();
};

const CS_CREATE_SO = slice('static string CreateSo(', 'static string CreatePo(');
const CS_CREATE_PO = slice('static string CreatePo(', '// ── conversions');
/* Anchor updated 2026-08-14: main renamed this comment from "The SDK's
   over-transfer dialog" to "OVER-TRANSFER: unreachable by construction" in
   #2041/#2043. The slice boundary is unchanged — Convert_ still ends on the
   line before it. */
const CS_CONVERT = slice('static string Convert_(', '/* OVER-TRANSFER:');
const CS_SO_TO_PO = slice('static string SoToPo(', 'static void SalesHeader(');
const CS_SALES_HEADER = slice('static void SalesHeader(', 'static void PurchaseHeader(');
const CS_PURCHASE_HEADER = slice('static void PurchaseHeader(', '/* Source line keys');
const CS_DTLKEYS = slice('static long[] DtlKeys(', '// ── cancel');
const CS_CANCEL = slice('static void Cancel(', '// ── edit');
/* The signature changed on 2026-08-31 — /edit now RETURNS the document's line
   keys when it added a line, so the ERP can store them (docs/bugs/0583-*). The
   anchor follows the name, not the return type. */
const CS_EDIT = slice('Edit(Dictionary<string, object> p)', '// ── helpers');
const CS_APPLY_UDF = slice('static void ApplyUdf(', 'static Dictionary<string, object> Ok(');

const csEditHeaderAllowList = (): string[] => {
  const block = CS_EDIT.slice(CS_EDIT.indexOf('new string[] {'), CS_EDIT.indexOf('}) {'));
  return [...block.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort();
};

const detailKeys = (body: string) => keysRead(body, 'it');
const headerKeys = (body: string, bag = 'p') => keysRead(body, bag);

describe('layer 1 — the keys AcSyncService.cs parses, read out of its source', () => {
  test('/create-so', () => {
    expect(headerKeys(CS_CREATE_SO)).toEqual([
      'Attention', 'Agent', 'DebtorCode', 'DebtorName', 'DeliverAddr1', 'DeliverAddr2',
      'DeliverAddr3', 'DeliverAddr4', 'DeliverContact', 'DeliverPhone1', 'Details',
      'DocDate', 'DocNo', 'InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4', 'Phone',
      'Ref', 'SalesLocation',
      /* The DELIVERY DATE. AutoCount's sales-order header has no field of its
         own for it — the SDK puts `DeliveryDate` on the six DETAIL classes and
         nowhere else — so this book keeps it in the exemption expiry, which is
         where Inistate writes it too. Owner 2026-08-16. */
      'SalesExemptionExpiryDate',
    ].sort());
    expect(detailKeys(CS_CREATE_SO)).toEqual(
      ['DeliveryDate', 'Desc2', 'Description', 'ItemCode', 'Location', 'Qty', 'UnitPrice'].sort(),
    );
  });

  test('/so-to-po', () => {
    expect(headerKeys(CS_SO_TO_PO)).toEqual(
      ['CreditorCode', 'CreditorName', 'Details', 'DocNo', 'DtlKeys', 'FromDocNo'].sort(),
    );
    expect(detailKeys(CS_SO_TO_PO)).toEqual(['DeliveryDate', 'DtlKey', 'Location', 'Qty', 'UnitPrice']);
    expect(CS_SO_TO_PO).toContain('po.DocNo = Str(p, "DocNo");');
    expect(CS_SO_TO_PO).toContain('RequireDocNo(p, "/so-to-po");');
  });

  test('/create-po', () => {
    expect(headerKeys(CS_CREATE_PO)).toEqual(
      ['Agent', 'CreditorCode', 'CreditorName', 'Description', 'Details', 'DocDate', 'DocNo',
        'PurchaseLocation', 'Ref'].sort(),
    );
    expect(detailKeys(CS_CREATE_PO)).toEqual(
      ['DeliveryDate', 'Desc2', 'Description', 'ItemCode', 'Location', 'Qty', 'UnitPrice'].sort(),
    );
  });

  test('the four conversions, and the two header fields only one of them reads', () => {
    /* DtlKeys joined this list on 2026-08-16 and its presence is the FEATURE.
       AddPartialTransferDetail takes an ARRAY of line keys and never asks which
       document they came from, so a target can be built from SEVERAL sources -
       a DO from several sales orders, an invoice from several DOs, a GRN from
       several POs, a purchase invoice from several GRNs. The route used to
       demand FromDocNo unconditionally, which is what made that impossible;
       FromDocNo is now the FALLBACK, needed only when the ERP does not name the
       lines itself.

       THREE KEYS JOINED ON 2026-08-17, and each is one half of the owner's
       「partially transfer 跟 fully transfer 都要可以」. `PlanTransfer` is the ONE
       place that decides the shape and it decides it from the payload alone:

         DtlKeys absent   -> FULL, over FromDocNos ?? [FromDocNo]. `FromDocNos`
                             is new and is the multi-source WHOLE-document case:
                             the documented FullTransfer takes an ARRAY of
                             document numbers, so it needs no grouping.
         DtlKeys present  -> PARTIAL BY LINE, at each line's outstanding qty.
         Details[].Qty    -> PARTIAL BY QUANTITY. NOTHING SENDS THIS YET; see
                             divergence D14. The service reads it so the ERP can
                             say "3 of 5" without another C# deploy, and refuses
                             rather than shipping 5 when it cannot express it.

       DocDate is read here as well as in SalesHeader/PurchaseHeader because the
       vendor's examples set the document date on the target BEFORE the transfer
       and this service set it after.

       THE FOUR ACCOUNT KEYS JOINED ON 2026-08-17 AND THEY ARE THE FIX, not a
       tidy-up. PROVEN on the live host: a conversion whose target has no
       DebtorCode when the transfer runs is refused —
       `AppException: Debtor Code is empty.` from FullTransfer, and the
       contentless `Invalid transfer item.` from AddPartialTransferDetail. That
       is what kept HC-DO-2608-001, HC-DO-2608-002 and HC-SI-2608-001 out of the
       account book for a week. `cmd.AddNew()` creates the target empty and
       neither SalesHeader nor PurchaseHeader has ever set an account.

       The service reads them PAYLOAD-FIRST and falls back to the SOURCE
       document's own header in the book. Both halves are load-bearing: the
       payload half was divergence D15 (closed the same night — see the note in
       the register), and the book half is what makes the outbox rows queued
       BEFORE that payload change drain at all. Written out per side in the C#
       rather than through a ternary precisely so this assertion can see all four
       names.

       CreditorCode is read a SECOND time inside the GR and PI arms, guarded on
       being non-empty, and the guard is the point: Str() of an absent key is "",
       so an unguarded assignment there would blank the account the book fallback
       had just supplied. Asserted below. */
    expect(headerKeys(CS_CONVERT)).toEqual(
      ['CreditorCode', 'CreditorName', 'DebtorCode', 'DebtorName',
       'Details', 'DocDate', 'DtlKeys', 'FromDocNo', 'FromDocNos',
       'SupplierDONo', 'SupplierInvoiceNo'].sort(),
    );
    expect(detailKeys(CS_CONVERT)).toEqual(['DtlKey', 'Qty']);
    expect(headerKeys(CS_DTLKEYS)).toEqual(['DtlKeys']);
    expect(headerKeys(CS_SALES_HEADER)).toEqual(
      ['Attention', 'DebtorName', 'Description', 'DisplayTerm', 'DocDate', 'DocNo', 'Note',
        'Phone1', 'Ref'].sort(),
    );
    /* Agent joined this list on 2026-08-20 (#2523). `PurchaseHeader` is the
       header function BOTH /so-to-po and the four conversions apply, and only
       /create-po ever assigned the purchase agent — so a transfer could be sent
       a perfectly good Agent and still save without one, into
       FK_PO_PurchaseAgent. Guarded there (ContainsKey + non-empty) because the
       conversions send no Agent and Str() of an absent key is "".
       BOTH HALVES ARE THE SAME LESSON, arrived at on two branches the same day:
       carrying a field is not landing one. */
    expect(headerKeys(CS_PURCHASE_HEADER)).toEqual(
      ['Agent', 'Description', 'DisplayTerm', 'DocDate', 'DocNo', 'PurchaseLocation', 'Ref'].sort(),
    );
  });


  test('the GR and PI arms call the typed FullTransfer, spelled the way the SDK spells it', () => {
    expect(CS_CONVERT).toContain('AutoCount.Invoicing.Purchase.TransferFrom.GoodsReceiveNote');
    expect(CS_CONVERT).not.toContain('TransferFrom.GoodsReceivedNote');

    const fullTransferCalls = CS_CONVERT.match(
      /doc\.FullTransfer\(new string\[\]\{ fromDocNo \}, __ptf, AutoCount\.Invoicing\.FullTransferOption\.FullDetails\);/g,
    );
    expect(fullTransferCalls, 'the GR arm and the PI arm').toHaveLength(2);

    expect(
      (CS_CONVERT.match(/doc\.AddPartialTransferDetail\(fromType, g\.Value\.ToArray\(\), true\);/g) ?? []),
      'one per purchase arm, inside the catch',
    ).toHaveLength(2);

    expect(
      (CS_CONVERT.match(
        /if \(!string\.IsNullOrEmpty\(Str\(p, "CreditorCode"\)\)\) Set\(\(\) => doc\.CreditorCode = Str\(p, "CreditorCode"\)\);/g,
      ) ?? []),
      'guarded in both purchase arms',
    ).toHaveLength(2);

    expect((CS_CONVERT.match(/PurchaseHeader\(doc, p\);/g) ?? []), 'twice per purchase arm')
      .toHaveLength(4);
    expect((CS_CONVERT.match(/SalesHeader\(doc, p\);/g) ?? []), 'once per sales arm')
      .toHaveLength(2);

    expect(CS_CONVERT).toContain('The flag was never the cause.');
  });

  test.skip('/cancel takes exactly two fields', () => {
    expect(headerKeys(CS_CANCEL)).toEqual(['DocNo', 'DocType']);
  });

  test('/edit — the envelope, the header allow-list, and the line fields', () => {
    expect(headerKeys(CS_EDIT)).toEqual(['DocNo', 'DocType', 'Header', 'Lines'].sort());
    expect(headerKeys(CS_EDIT, 'h')).toEqual(['DocDate', 'SalesExemptionExpiryDate']);
    expect(csEditHeaderAllowList()).toEqual([
      'Agent', 'Attention', 'CreditorName', 'DebtorName', 'DeliverAddr1', 'DeliverAddr2',
      'DeliverAddr3', 'DeliverAddr4', 'DeliverContact', 'DeliverPhone1', 'Description',
      'InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4', 'Note', 'Phone1', 'Ref',
      'Remark1', 'Remark2', 'Remark3', 'Remark4', 'SalesLocation',
    ].sort());
    /* `Gone` was in this list for part of 2026-09-02 and is deliberately NOT any
       more. It is an ERP-side fact — composeEdit reads it to decide whether the
       line SET changed and therefore whether to rebuild (services/ac-line-gone.ts,
       docs/bugs/0608) — and the host stopped reading it when the per-type
       DeleteDetail branch was removed. It still rides along in Lines and is
       ignored, which is why it must be absent HERE: this list is what the SERVICE
       parses, and listing a key it does not read would make the contract lie in
       the direction that reads as safe. */
    expect(detailKeys(CS_EDIT)).toEqual(
      ['DeliveryDate', 'Desc2', 'Description', 'DtlKey', 'FurtherDescription',
       'ItemCode', 'Location', 'Photos', 'Qty', 'UnitPrice'].sort(),
    );
  });

  test('UDF is a free-form dictionary the service writes key-for-key, and NAMES a key that will not land', () => {
    expect(headerKeys(CS_APPLY_UDF)).toEqual(['UDF']);
    expect(CS_APPLY_UDF).toContain('SetUdf(k, v, set);');
    expect(CS_APPLY_UDF).toContain('shapes.Add("String"); values.Add(v);');
    expect(CS_APPLY_UDF).toContain('Log("  UDF " + k + " = \'" + v + "\' NOT APPLIED');
    expect(acSyncSource).toContain('static void Set(Action a) { try { a(); } catch (Exception ex) { Log("  set skipped: " + ex.Message); } }');
  });

  test('a MISSING key and a NULL key are the same thing to this service, and both mean ""', () => {
    expect(acSyncSource).toContain(
      'static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }',
    );
  });
});


function columnsOf(table: string): string[] {
  const head = `CREATE TABLE "${table}" (`;
  const a = scmSchemaSql.indexOf(head);
  expect(a, `no CREATE TABLE for ${table} in the scm schema dump`).toBeGreaterThanOrEqual(0);
  const body = scmSchemaSql.slice(a + head.length, scmSchemaSql.indexOf('\n);', a));
  return [...body.matchAll(/^\s*"([a-z0-9_]+)"\s+/gm)].map((m) => m[1]);
}

const LATER_MIGRATIONS: Record<string, string[]> = {
  mfg_sales_orders: ['company_id', 'linked_ac_docno'],
  // 0083 (company_id), 0273 (linked_ac_dtlkey — PR #1819)
  mfg_sales_order_items: ['company_id', 'linked_ac_dtlkey'],
  purchase_orders: [
    'supplier_delivery_date_2', 'supplier_delivery_date_3', 'supplier_delivery_date_4',
    'revision', 'company_id', 'po_email_sent_at', 'po_email_sent_to',
    'linked_ac_grn_docnos', 'linked_ac_pinv_docnos', 'linked_ac_docno',
  ],
  // 0083 (company_id), 0273 (linked_ac_dtlkey — PR #1819), 0274 (photo_urls), 20260910T0547 (line_no)
  purchase_order_items: ['company_id', 'linked_ac_dtlkey', 'photo_urls', 'line_no'],
  suppliers: ['company_id'],
};

const schemaOf = (table: string, omit: string[] = []): Set<string> =>
  new Set([...columnsOf(table), ...(LATER_MIGRATIONS[table] ?? [])].filter((c) => !omit.includes(c)));

type Row = Record<string, any>;

function fakeSb(tables: Record<string, Row[]>, omit: Record<string, string[]> = {}) {
  const schemas: Record<string, Set<string>> = {
    mfg_sales_orders: schemaOf('mfg_sales_orders', omit.mfg_sales_orders),
    mfg_sales_order_items: schemaOf('mfg_sales_order_items', omit.mfg_sales_order_items),
    purchase_orders: schemaOf('purchase_orders', omit.purchase_orders),
    purchase_order_items: schemaOf('purchase_order_items', omit.purchase_order_items),
    suppliers: schemaOf('suppliers', omit.suppliers),
  };
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let window: [number, number] | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let columnError: { code: string; message: string } | null = null;
    const rows = () => {
      let rs = tables[table].filter((r) => filters.every((f) => f(r)));
      if (limitN != null) rs = rs.slice(0, limitN);
      if (window) rs = rs.slice(window[0], window[1] + 1);
      return rs;
    };
    const settle = () => {
      if (columnError) return { data: null, error: columnError };
      if (pendingInsert) {
        tables[table].push({ id: `row-${tables[table].length + 1}`, ...pendingInsert });
        return { data: null, error: null };
      }
      if (pendingUpdate) {
        for (const r of rows()) Object.assign(r, pendingUpdate);
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const builder: any = {
      select(cols?: string) {
        const known = schemas[table];
        if (known && cols) {
          const missing = cols.split(',').map((c) => c.trim()).filter((c) => c && !known.has(c));
          if (missing.length) {
            columnError = {
              code: '42703',
              message: `column ${table}.${missing[0]} does not exist`,
            };
          }
        }
        return builder;
      },
      insert(payload: Row) { pendingInsert = payload; return builder; },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      /* The ESCAPED in-list the shared readers now build (docs/bugs/0780). */
      filter(col: string, op: string, val: string) {
        if (op !== 'in') throw new Error(`fake: filter(${op}) is not implemented`);
        const vals = parsePgrestInList(val);
        filters.push((r: Record<string, unknown>) => vals.includes(String(r[col])));
        return builder;
      },
      lt(col: string, val: unknown) { filters.push((r) => Number(r[col] ?? 0) < Number(val)); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      range(from: number, to: number) { window = [from, to]; return builder; },
      maybeSingle: async () => (columnError ? { data: null, error: columnError } : { data: rows()[0] ?? null, error: null }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return builder;
  };
  return { from, tables } as never as { from: (t: string) => any; tables: Record<string, Row[]> };
}


const SO_HEADER = {
  doc_no: 'SO-2608-011',
  so_date: '2026-08-11',
  debtor_name: 'Tan Ah Kow',
  agent: 'kar jiun',
  sales_location: 'PETALING JAYA',
  branding: 'akemi',
  venue: 'KSL CITY MALL',
  address1: 'No 1 Jalan Trial',
  address2: 'Taman Trial',
  address3: '47800 Petaling Jaya',
  address4: 'Selangor',
  phone: '0123456789',
  ref: 'WALK-IN',
  po_doc_no: 'CUST-PO-7',
  company_id: 1,
  linked_ac_docno: null,
};

const SO_ITEMS = [
  {
    doc_no: 'SO-2608-011', item_code: 'AKEMI-SOLITUDE-Q', item_group: 'mattress',
    description: 'AKEMI SOLITUDE MATTRESS QUEEN', description2: 'QUEEN 5x6.5',
    qty: 1, unit_price_sen: 199_900, discount_sen: 0, variants: null,
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-01',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'ANNSA-1B(LHF)', item_group: 'sofa',
    description: 'SOFA ANNSA', description2: null,
    qty: 1, unit_price_sen: 150_000, discount_sen: 30_000,
    variants: { buildKey: 'build-1', cellIndex: 0, fabricColor: 'HR805-30', fabricLabel: 'Linen' },
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-15',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'ANNSA-CNR', item_group: 'sofa',
    description: 'SOFA ANNSA', description2: null,
    qty: 1, unit_price_sen: 150_000, discount_sen: 0,
    variants: { buildKey: 'build-1', cellIndex: 1, fabricColor: 'HR805-30', fabricLabel: 'Linen' },
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-15',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'ANNSA-2A(RHF)', item_group: 'sofa',
    description: 'SOFA ANNSA', description2: null,
    qty: 1, unit_price_sen: 150_000, discount_sen: 0,
    variants: { buildKey: 'build-1', cellIndex: 2, fabricColor: 'HR805-30', fabricLabel: 'Linen' },
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-15',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'SVC-DELIVERY', item_group: 'service',
    description: 'Delivery', description2: null,
    qty: 1, unit_price_sen: 15_000, discount_sen: 0, variants: null,
    location: null, warehouse_id: null, line_delivery_date: null,
  },
];

const PO_HEADER = {
  id: 'po-uuid-1', po_number: 'PO-2608-004', po_date: '2026-08-11',
  supplier_id: 'supplier-uuid-1', notes: 'Trial purchase order',
  purchase_location_id: 'wh-kl',
  company_id: 1, linked_ac_docno: null,
};

const SUPPLIER = {
  id: 'supplier-uuid-1', code: '400-T001', name: 'Trial Supplier Sdn Bhd',
  company_id: 1,
};

const PO_ITEMS = [
  {
    purchase_order_id: 'po-uuid-1', item_code: 'AKEMI-SOLITUDE-Q', item_group: 'mattress',
    description: 'AKEMI SOLITUDE MATTRESS QUEEN', qty: 2, unit_price_sen: 90_000,
    discount_sen: 0, variants: null, warehouse_id: 'wh-kl', delivery_date: '2026-09-20',
  },
];

const seeded = (omit: Record<string, string[]> = {}) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: 'all' }],
  autocount_outbox: [],
  mfg_sales_orders: [{ ...SO_HEADER }],
  mfg_sales_order_items: SO_ITEMS.map((r, i) => ({ ...r, linked_ac_dtlkey: i === 0 ? 4242 : null })),
  purchase_orders: [{ ...PO_HEADER }],
  suppliers: [{ ...SUPPLIER }],
  purchase_order_items: PO_ITEMS.map((r) => ({ ...r, linked_ac_dtlkey: null })),
  delivery_orders: [{ id: 'do-uuid-1', do_number: 'DO-2608-009', linked_ac_docno: null }],
  grns: [{
    id: 'grn-uuid-1', grn_number: 'GRN-2608-003', linked_ac_docno: null,
    supplier_id: 'supplier-uuid-1',
  }],
  sales_invoices: [{ id: 'si-uuid-1', invoice_number: 'SI-2608-002', linked_ac_docno: null }],
  purchase_invoices: [{ id: 'pi-uuid-1', invoice_number: 'PI-2608-002', linked_ac_docno: null }],
}, omit);

const ENV = { AC_SYNC_URL: 'http://ac-test.invalid:8900', AC_SYNC_KEY: 'not-a-real-key' } as never;

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


interface Divergence {
  id: string;
  flow: string;
  field: string;
  service: string;
  erp: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Every place the two sides do NOT agree. This list is load-bearing: the
 * assertions below are written against it, so adding a divergence without an
 * entry fails, and fixing one without deleting its entry also fails.
 *
 * It is deliberately a list of FINDINGS, not of fixes. Each of these needs a
 * decision that is not a test author's to make.
 *
 * THE PROSE HOME OF THIS LIST IS NOT "SECTION 11". This comment and the count
 * assertion below both pointed there until 2026-08-15, and the module guide has
 * never had a section 11 — so the one instruction a reader is given when this
 * test fails sent them to a heading that does not exist. D9 and D10 are written
 * up in **7b**, D8 in **7d2**, and the fields the extract proves are missing in
 * **7q**. (This paragraph was written while striking D3; a pointer that rots
 * beside the list it points at is the failure the guide keeps warning about.)
 */
export const DIVERGENCES: Divergence[] = [
  {
    id: 'D1', flow: 'create_so', field: 'UDF.*',
    service: 'writes whatever key it is given and swallows an unknown one (AcSyncService.cs:413-420 + :436), so the key must be the book\'s own UDF column name. Every other record in this repo spells those SOUDF_BRANDING / SOUDF_VENUE / SOUDF_ToPONo — services/pull.ts:164,182,177, types.ts:236, and services/autocount.ts:249 which WRITES POUDF_EDate to the live book today.',
    erp: 'sends BRANDING / VENUE / ToPONo, unprefixed (autocount-writeback.ts:285-289). If the book\'s fields are the prefixed ones, branding, venue and the customer PO number are silently dropped.',
    severity: 'high',
  },
  {
    id: 'D2', flow: 'create_so + create_po', field: 'Details[].Location',
    service: 'assigns it unconditionally, and Str() turns null into "" (AcSyncService.cs:186/213 + :427), so a null blanks the line location rather than leaving AutoCount\'s own.',
    erp: 'always null: soLine (autocount-outbox.ts:142-151) never reads a location, and the selects (:169,:203) do not fetch one — though scm.mfg_sales_order_items has warehouse_id and the PO items table has one too.',
    severity: 'medium',
  },
  {
    id: 'D17', flow: 'so_to_do + do_to_iv', field: 'SalesLocation / Description',
    service: '`SalesHeader` (AcSyncService.cs:2422) has no SalesLocation slot at all — only /edit\'s reflection loop does (:2990-2995) — while the sales CREATE route treats the header location as mandatory (FK_SO_SalesLocation, MissingSalesLocationError). And it assigns Description unconditionally, so an absent key writes "".',
    erp: 'sends neither. `scm.delivery_orders` and `scm.sales_invoices` carry no warehouse column, so there is no header location to send and inventing one would be a foreign key error rather than an empty field. Description is worse than absent: those two tables carry TWO note columns — `note`, mapped to AutoCount\'s Note since /edit was written, and `notes`, mapped nowhere — and picking one as the book\'s Description is a guess about the owner\'s intent, not a code change. Costs nothing today (the sales arms build with transferMaster:false, AcSyncService.cs:1096, so the "" overwrites nothing), which is exactly why it needs a decision and not a patch.',
    severity: 'low',
  },
  /* D5 STRUCK 2026-08-17 — DocNo, on every flow that creates a document.
     `enqueueConvert` closed it for the four conversions; `/so-to-po` was the one
     route left, and it stayed open on purpose ("one variable at a time on a
     route that has never succeeded"). The route succeeded on 2026-08-17 10:15
     and immediately produced the thing D5 predicts: `PO-009968` in AED_HOUZS for
     the purchase order the ERP calls `HC-PO-2608-001`. `composeSoToPo` now takes
     the number as its first REQUIRED argument, `dispatchOne` backfills it from
     `row.doc_no` for anything already queued, and `SoToPo` carries the same
     `RequireDocNo` guard as the two create routes. It leaves the register
     because it was a plain gap with no decision left in it — the owner's
     instruction is 「那 Numbering 你要处理掉啊，怎么可以不一样 Numbering 呢？」 —
     and the two tests below fail if either half is reverted.

     WHAT THE FIX DOES NOT DO: `PO-009968` keeps its number. Nothing here renames
     a document already in a live account book. See §7c3a for what has to happen
     to that one. */
  {
    id: 'D6', flow: 'edit', field: 'Lines[].ItemCode',
    service: 'applies ItemCode ONLY to a line it is appending; for a line addressed by DtlKey it is never read (AcSyncService.cs:395-401). A product swap cannot change the AutoCount item code.',
    erp: 'hooks tbc-swap and tbc-swap-sofa — which change the product — to enqueueEdit, and docs/modules/autocount-writeback.md:168 states the opposite: "AutoCount takes it as Desc2 + ItemCode on the same DtlKey". It does not.',
    severity: 'high',
  },
  {
    id: 'D7', flow: 'edit', field: 'Lines[] (a deleted line)',
    service: 'has no delete: only SalesOrder exposes DeleteDetail in this SDK, so the service deliberately does not offer one (AcSyncService.cs:386-391).',
    erp: 'hooks DELETE /:docNo/items/:itemId to queueAcSoEdit, which composes the lines that still exist. The deleted line stays in AutoCount for ever and nothing anywhere reports it.',
    severity: 'high',
  },
  {
    id: 'D8', flow: 'edit', field: 'Header.Agent / Header.SalesLocation / Header.DocDate / UDF',
    service: 'would apply all four (AcSyncService.cs:371-383).',
    erp: 'composeSoState sends DebtorName / Attention / Ref / Phone1 / InvAddr1-4 only (autocount-outbox.ts:456-465), so changing the salesperson, the sales location, the order date, the branding or the venue on a live order never reaches AutoCount.',
    severity: 'medium',
  },
  {
    id: 'D9', flow: 'create_so + create_po + edit', field: 'Details[] — a sofa build',
    service: 'takes the lines it is given, one AutoCount detail per element.',
    erp: 'sends one line PER COMPARTMENT. scm/shared/so-sofa-split.ts:83 stores a sold sofa as N rows sharing variants.buildKey, each qty 1 with a share of the price, and toDetails (autocount-writeback.ts:248) is a plain 1:1 map. With makeItemCodeResolver\'s parent collapse every one of those rows carries the SAME AutoCount sofa code — so one sofa sold books qty N in AutoCount and takes N off its stock. The ERP\'s own fold, groupSoLinesForDisplay (scm/shared/so-line-display.ts:155), is the arithmetic this needs.',
    severity: 'critical',
  },
  {
    id: 'D10', flow: 'create_so + create_po + edit', field: 'Details[].ItemCode',
    service: 'assigns ItemCode unconditionally on a create (AcSyncService.cs:181/208); an item code the book does not have fails the save.',
    erp: 'sends the raw ERP item_code / item_code. makeItemCodeResolver exists and is never called by anything but its own unit test — every compose* call takes the default identityResolver, so no ERP code is ever mapped to an AutoCount one.',
    severity: 'critical',
  },
  /* D11 (create_po + edit(PO): CreditorCode / CreditorName / Agent / Ref read
     off columns scm.purchase_orders has never had) is FIXED in #1855 and struck
     off: the PO reads name the real columns and join scm.suppliers for the
     creditor, and the PO edit omits Ref instead of blanking the book's own.
     Proven by '/create-po — the creditor comes from scm.suppliers' below. */
  {
    id: 'D12', flow: 'create_so + create_po + edit', field: 'Details[] — line discount',
    service: 'reads no discount field; SalesOrderDetail exposes Discount and DiscountAmt (sdk-api-reference.txt:468) and neither is in the payload contract.',
    erp: 'has discount_sen on both item tables and never sends it, so the AutoCount document total is the undiscounted one. On a sofa the discount sits on ONE compartment row (mfg-sales-orders.ts:4398), which makes it easy to miss.',
    severity: 'high',
  },
  /* D13 (every line dropped, because the line select named linked_ac_dtlkey and
     PostgREST fails the WHOLE query with 42703) is FIXED and struck off: PR
     #1819 landed migration 0273 so the column exists, and #1855 no longer turns
     a failed read into an empty line list — it throws, logs, and writes a
     'skipped' outbox row instead of composing. Proven by 'a line read that
     fails composes NOTHING' below, which takes the column away again. */
  {
    id: 'D14', flow: 'the four conversions', field: 'Details[].DtlKey + Details[].Qty',
    service: 'reads a per-line quantity as of 2026-08-17 (PlanTransfer), which is what turns a conversion into a PARTIAL BY QUANTITY transfer. Given none it transfers each named line at its OUTSTANDING quantity, so a DO shipping 3 of a 5-unit sales-order line still writes 5 into the account book. Given a Qty it uses the documented PartialTransfer, and if that call cannot be bound it REFUSES rather than falling back to the primitive, which would ship the 5.',
    erp: 'never sends it. enqueueConvert composes { DocNo, DocDate?, Ref?, DtlKeys? } and readConvertSourceKeys resolves LINE IDENTITY only — its own doc comment says "NOT COVERED, and deliberately so: partial QUANTITY on a line". So partial SHIPMENT (a subset of lines) reaches AutoCount correctly and partial QUANTITY does not, and the two look identical from the ERP side.',
    severity: 'high',
  },
  {
    id: 'D16', flow: 'po_to_gr + gr_to_pi', field: 'DtlKeys — the named subset is ignored',
    service: 'the GR and PI arms try the typed three-argument FullTransfer FIRST and keep AddPartialTransferDetail only as a catch fallback. FullTransfer moves EVERY outstanding line on the source document, so a payload that NAMES two of five lines still transfers five. It is the only shape ever observed to move a purchase conversion into the live book (host 2026-08-17 23:09), and on that run the named set WAS every outstanding line, so nothing was over-received and the defect is unobserved rather than absent.',
    erp: 'sends DtlKeys naming exactly the lines the GRN or purchase invoice took — readConvertSourceKeys refuses rather than guess — and has no way to say "and this really is all of them". So the ERP is correct and is ignored, which is the opposite failure to D14: there the ERP cannot express a partial QUANTITY, here it expresses a partial LINE SET that the service overrides. Cost: a partial receipt writes goods into a live account book that the ERP did not receive. The purchase side is deliberately not made to refuse instead, because refusing returns po_to_gr to the state it spent a week in.',
    severity: 'high',
  },
];


describe('/create-so — the body dispatchOne would POST', () => {
  test('D13 struck: a line read that fails composes NOTHING, and writes down why', async () => {
    const sb = seeded({ mfg_sales_order_items: ['linked_ac_dtlkey'] });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' })).queued).toBe(false);

    const rows = sb.tables.autocount_outbox;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].last_error).toContain('42703');
    expect(rows.filter((r) => r.status === 'pending')).toEqual([]);
    expect(rows.some((r) => Array.isArray((r.payload as any)?.body?.Details))).toBe(false);
  });

  test.skip('every field, against the shape CreateSo parses', async () => {
    const sb = seeded();
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' })).queued).toBe(true);

    expect(await wireBody(sb)).toEqual({
      DocNo: 'SO-2608-011',
      DocDate: '2026-08-11',
      DebtorCode: '300-C002',
      DebtorName: 'Tan Ah Kow',
      Agent: 'TAN KAR JIUN',
      SalesLocation: 'KL',
      Ref: 'WALK-IN',
      Phone: '0123456789',
      Attention: 'Tan Ah Kow',
      InvAddr1: 'No 1 Jalan Trial',
      InvAddr2: 'Taman Trial',
      InvAddr3: '47800 Petaling Jaya',
      InvAddr4: 'Selangor',
      UDF: { BRANDING: 'AKEMI', VENUE: 'KSL CITY MALL JOHOR SOLO', ToPONo: 'CUST-PO-7' },
      Details: [
        {
          ItemCode: 'AKEMI-SOLITUDE-Q',
          Description: 'AKEMI SOLITUDE MATTRESS QUEEN',
          Desc2: 'QUEEN 5x6.5',
          Qty: 1,
          UnitPrice: 1999,
          Location: null,
          DeliveryDate: null,
        },
        {
          ItemCode: 'ANNSA-1B(LHF)', Description: 'SOFA ANNSA',
          Desc2: 'Col: HR805-30 / Fabric: Linen', Qty: 1, UnitPrice: 1500,
          Location: null, DeliveryDate: null,
        },
        {
          ItemCode: 'ANNSA-CNR', Description: 'SOFA ANNSA',
          Desc2: 'Col: HR805-30 / Fabric: Linen', Qty: 1, UnitPrice: 1500,
          Location: null, DeliveryDate: null,
        },
        {
          ItemCode: 'ANNSA-2A(RHF)', Description: 'SOFA ANNSA',
          Desc2: 'Col: HR805-30 / Fabric: Linen', Qty: 1, UnitPrice: 1500,
          Location: null, DeliveryDate: null,
        },
        {
          ItemCode: 'SVC-DELIVERY', Description: 'Delivery',
          Desc2: null, Qty: 1, UnitPrice: 150,
          Location: null, DeliveryDate: null,
        },
      ],
    });
  });

  test('no key is sent that CreateSo does not read — a typo would land here', async () => {
    const sb = seeded();
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' });
    const body = await wireBody(sb);
    const read = new Set(headerKeys(CS_CREATE_SO));
    expect(Object.keys(body).filter((k) => !read.has(k) && k !== 'UDF')).toEqual([]);

    const detailRead = new Set(detailKeys(CS_CREATE_SO));
    for (const d of body.Details as Record<string, unknown>[]) {
      expect(Object.keys(d).filter((k) => !detailRead.has(k))).toEqual([]);
    }
  });

  test('what CreateSo reads and the ERP never sends, and why each one is safe', async () => {
    const sb = seeded();
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' });
    const body = await wireBody(sb);
    const sent = new Set(Object.keys(body));
    expect(headerKeys(CS_CREATE_SO).filter((k) => !sent.has(k) && k !== 'Details')).toEqual([
      /* All four fall back to the invoice address, and DeliverContact to the
         debtor name — AcSyncService's create does the Or() itself, so omitting
         them is the intended shape.

         DELIVERPHONE1 LEFT THIS LIST on 2026-08-15. It was here on the strength
         of that same Or(), and the Or() is not the same statement: it makes the
         DELIVERY number a copy of the CUSTOMER's, and the owner's ruling is that
         they are two contacts ("应该是有一个 Delivery Contact，一个是 Contact").
         The ERP has both — `phone` and `emergency_contact_phone` — and the
         cutover already paired them in this direction. It is now sent, so a
         delivery-day number that differs from the customer's survives, and an
         EDIT that changes it reaches the book at all. */
      'DeliverAddr1', 'DeliverAddr2', 'DeliverAddr3', 'DeliverAddr4',
      'DeliverContact',
    ]);
  });
});

describe('/create-po — the creditor comes from scm.suppliers', () => {
  test('D11 struck: the four columns are still absent, and nothing asks for them', () => {
    const cols = schemaOf('purchase_orders');
    for (const phantom of ['creditor_code', 'creditor_name', 'agent', 'ref']) {
      expect(cols.has(phantom), `purchase_orders.${phantom} should not exist`).toBe(false);
    }
    expect(cols.has('supplier_id')).toBe(true);
    expect(cols.has('notes')).toBe(true);
    expect(schemaOf('suppliers').has('code')).toBe(true);
    expect(schemaOf('suppliers').has('name')).toBe(true);
  });

  test.skip('a PO create queues, and the body carries the supplier CODE', async () => {
    const sb = seeded();
    expect((await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' })).queued).toBe(true);
    expect(sb.tables.autocount_outbox).toHaveLength(1);

    const body = await wireBody(sb);
    expect(body.CreditorCode).toBe('400-T001');
    expect(body).toEqual({
      DocNo: 'PO-2608-004',
      DocDate: '2026-08-11',
      CreditorCode: '400-T001',
      CreditorName: 'Trial Supplier Sdn Bhd',
      Agent: null,
      Ref: null,
      Description: 'Trial purchase order',
      UDF: {},
      Details: [
        {
          ItemCode: 'AKEMI-SOLITUDE-Q',
          Description: 'AKEMI SOLITUDE MATTRESS QUEEN',
          Desc2: null,
          Qty: 2,
          UnitPrice: 900,
          Location: null,
          DeliveryDate: null,
        },
      ],
    });
  });

  test.skip('no key is sent that CreatePo does not read', async () => {
    const sb = seeded();
    await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' });
    const body = await wireBody(sb);
    const read = new Set(headerKeys(CS_CREATE_PO));
    expect(Object.keys(body).filter((k) => !read.has(k) && k !== 'UDF')).toEqual([]);
    const detailRead = new Set(detailKeys(CS_CREATE_PO));
    for (const d of body.Details as Record<string, unknown>[]) {
      expect(Object.keys(d).filter((k) => !detailRead.has(k))).toEqual([]);
    }
  });

  test.skip('a PO edit reaches AutoCount too, and leaves the book\'s own Ref alone', async () => {
    const sb = seeded();
    sb.tables.purchase_orders[0].linked_ac_docno = 'AC-PO-7';
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'PO', docId: 'po-uuid-1' })).toBe(true);

    const body = await wireBody(sb);
    expect(body.DocType).toBe('PO');
    expect(body.DocNo).toBe('AC-PO-7');
    expect(body.Header).toEqual({
      CreditorName: 'Trial Supplier Sdn Bhd',
      Description: 'Trial purchase order',
    });
    const allow = new Set(csEditHeaderAllowList());
    expect(Object.keys(body.Header as object).filter((k) => !allow.has(k))).toEqual([]);
    expect(body.Lines).toHaveLength(1);
  });

  test('a PO whose supplier read fails composes NOTHING — the D13 mechanism, on the PO side', async () => {
    const sb = seeded({ suppliers: ['code'] });
    expect((await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' })).queued).toBe(false);
    const rows = sb.tables.autocount_outbox;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].last_error).toContain('42703');
  });
});

/* ── /so-to-po: the supplier ────────────────────────────────────────────────
   MEASURED ON THE LIVE HOST 2026-08-17 09:15, and again at 09:20 when the cron
   tried again:

     ERROR /so-to-po: System.Exception: CreditorCode required for /so-to-po -
     AutoCount defaults the payment term from the supplier, and without one the
     save dies on FK_PO_DisplayTerm, which names the term and not the supplier

   `composeSoToPo` returns { DtlKeys, Details } and nothing else, so the whole
   master went missing the moment `poTransferShape` said `transfer` — `body`,
   built by `composeCreatePo` three lines earlier and carrying CreditorCode, is
   thrown away on that branch. Same defect as the debtor on the sales side, in
   the one place #2340 and #2341 did not reach.

   The seeded fixture takes the CREATE branch (its PO line has no `so_item_id`),
   so a transfer needs the link built here: a PO line pointing at an SO line
   that carries a `linked_ac_dtlkey`, with no allocation rows. */
const soToPoSb = () => {
  const sb = seeded();
  sb.tables.mfg_sales_order_items[0].id = 'so-item-1';
  sb.tables.purchase_order_items[0].so_item_id = 'so-item-1';
  sb.tables.purchase_order_item_allocations = [];
  sb.tables.warehouses = [{ id: 'wh-kl', code: 'KL', name: 'KL Warehouse' }];
  return sb;
};

describe('/so-to-po names the supplier', () => {
  test('the fixture really does take the TRANSFER branch — otherwise this file proves nothing', async () => {
    const sb = soToPoSb();
    expect((await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' })).queued).toBe(true);
    expect(sb.tables.autocount_outbox[0].op).toBe('so_to_po');
  });

  test('the enqueued body carries CreditorCode', async () => {
    const sb = soToPoSb();
    await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' });
    const stored = (sb.tables.autocount_outbox[0].payload as any).body;
    expect(stored.CreditorCode, 'the supplier the ERP is buying from').toBe(SUPPLIER.code);
    expect(stored.CreditorName).toBe(SUPPLIER.name);
    expect(stored.DtlKeys).toEqual([4242]);
  });

  test('a row stored WITHOUT one is backfilled at drain, from the ERP purchase order', async () => {
    const sb = soToPoSb();
    await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' });
    const row = sb.tables.autocount_outbox[0];
    delete (row.payload as any).body.CreditorCode;
    delete (row.payload as any).body.CreditorName;
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-PARENT-1';

    const body = await wireBody(sb);
    expect(body.CreditorCode, 'resolved at drain, so no requeue is needed').toBe(SUPPLIER.code);
  });

  test('the backfill does NOT overwrite a creditor the payload already names', async () => {
    const sb = soToPoSb();
    await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' });
    (sb.tables.autocount_outbox[0].payload as any).body.CreditorCode = '400-OTHER';
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-PARENT-1';
    const body = await wireBody(sb);
    expect(body.CreditorCode).toBe('400-OTHER');
  });
});

/* ── /so-to-po: the document NUMBER (divergence D5, struck) ─────────────────
   MEASURED ON THE LIVE HOST 2026-08-17 10:15, the first time this route ever
   succeeded:

     so-to-po PO-009968: 2 transferred, 2 line(s) costed in phase two

   `PO-009968` is AutoCount's counter. The ERP calls that same purchase order
   `HC-PO-2608-001`, and every other document type in the chain already carries
   the ERP's number into AED_HOUZS — HC-SO-2608-001/2/3, HC-DO-2608-001/2,
   HC-SI-2608-001. A document numbered differently on the two sides cannot be
   reconciled by anyone, which is the owner's whole point:
   「那 Numbering 你要处理掉啊，怎么可以不一样 Numbering 呢？」

   Same shape as the CreditorCode defect directly above and it needs the same two
   halves — the enqueue, and the drain for rows already in the queue. */
describe('/so-to-po carries the ERP document number', () => {
  const enqueue = (sb: ReturnType<typeof soToPoSb>) =>
    // eslint-disable-next-line no-restricted-syntax -- the fake PostgREST is not a SupabaseClient and enqueuePoCreate takes one; this is the file's existing bridge, named once instead of at five call sites
    enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' });
  const storedBody = (sb: ReturnType<typeof soToPoSb>): Record<string, unknown> =>
    (sb.tables.autocount_outbox[0].payload as { body: Record<string, unknown> }).body;

  test('the enqueued body carries DocNo, and it is the ERP purchase order number', async () => {
    const sb = soToPoSb();
    await enqueue(sb);
    expect(sb.tables.autocount_outbox[0].op).toBe('so_to_po');
    const stored = storedBody(sb);
    expect(stored.DocNo, 'the ERP numbers its own purchase orders').toBe(PO_HEADER.po_number);
    expect(stored.DtlKeys).toEqual([4242]);
  });

  test('the number reaches the WIRE, not just the stored row', async () => {
    const sb = soToPoSb();
    await enqueue(sb);
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-PARENT-1';
    const body = await wireBody(sb);
    expect(body.DocNo).toBe(PO_HEADER.po_number);
    expect(body.FromDocNo).toBe('AC-PARENT-1');
    expect(body.DocNo).not.toBe(body.FromDocNo);
  });

  test('a row stored WITHOUT one is backfilled at drain from the outbox row itself', async () => {
    const sb = soToPoSb();
    await enqueue(sb);
    delete storedBody(sb).DocNo;
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-PARENT-1';
    const body = await wireBody(sb);
    expect(body.DocNo, 'resolved at drain, so no requeue is needed').toBe(PO_HEADER.po_number);
  });

  test('the backfill does NOT overwrite a number the payload already names', async () => {
    const sb = soToPoSb();
    await enqueue(sb);
    storedBody(sb).DocNo = 'HC-PO-2608-999';
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-PARENT-1';
    expect((await wireBody(sb)).DocNo).toBe('HC-PO-2608-999');
  });

  test('the service REFUSES a /so-to-po with no number, so a silent auto-number is impossible', () => {
    expect(CS_SO_TO_PO).toContain('RequireDocNo(p, "/so-to-po");');
    expect(acSyncSource).toContain(
      'if (string.IsNullOrEmpty(Str(p, "DocNo").Trim()))',
    );
  });
});

/* ── /so-to-po: THE WHOLE MASTER, not one field per outage ──────────────────
   THE POINT OF THIS BLOCK IS THAT IT IS NOT ABOUT ANY ONE FIELD.

   Two fields have reached the live account book wrong on this route, each found
   only when a real document failed, and each patched on its own:

     CreditorCode  2026-08-17 09:15  `CreditorCode required for /so-to-po`
     DocNo         2026-08-17 10:15  the first transfer landed as `PO-009968`

   Both are the SAME defect — `composeCreatePo` builds a nine-field master and
   the transfer arm threw the whole object away — and after two one-field
   patches five were still missing (DocDate, Agent, Ref, Description, UDF), one
   of which is `Description`, the field the owner reported wrong on 2026-08-19:
   「为什么 Sales Order to PO，它的 Description2 不对的呢？」

   So the assertion is structural: whatever `composeCreatePo` sends, the
   transfer sends too, minus a NAMED list of deliberate exclusions. A field
   added to the create next month cannot silently fail to reach a transfer,
   because this test names it the day it is added. */
describe('/so-to-po carries the whole master', () => {
  /* eslint-disable-next-line no-restricted-syntax -- the fake PostgREST is not a SupabaseClient and enqueuePoCreate takes one; the file's existing bridge, named once */
  const enqueue = (sb: ReturnType<typeof seeded>) => enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' });
  const storedBody = (sb: ReturnType<typeof seeded>): Record<string, unknown> =>
    (sb.tables.autocount_outbox[0].payload as { body: Record<string, unknown> }).body;

  const createPoSb = () => {
    const sb = seeded();
    sb.tables.warehouses = [{ id: 'wh-kl', code: 'KL', name: 'KL Warehouse' }];
    return sb;
  };

  const TRANSFER_REPLACES = new Set(['Details']);

  test('the fixtures really take the two DIFFERENT arms — otherwise this block proves nothing', async () => {
    const c = createPoSb();
    await enqueue(c);
    expect(c.tables.autocount_outbox[0].op, 'the create control').toBe('create_po');

    const t = soToPoSb();
    await enqueue(t);
    expect(t.tables.autocount_outbox[0].op, 'the transfer under test').toBe('so_to_po');
  });

  test('every header field the CREATE sends, the TRANSFER sends', async () => {
    const c = createPoSb();
    await enqueue(c);
    const created = storedBody(c);

    const t = soToPoSb();
    await enqueue(t);
    const transferred = storedBody(t);

    const missing = Object.keys(created)
      .filter((k) => !TRANSFER_REPLACES.has(k))
      .filter((k) => !(k in transferred));
    expect(
      missing,
      `the SO->PO transfer drops ${missing.length} field(s) the create carries: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('and their VALUES are the same document, not just the same key names', async () => {
    const c = createPoSb();
    await enqueue(c);
    const created = storedBody(c);

    const t = soToPoSb();
    await enqueue(t);
    const transferred = storedBody(t);

    /* A key present with a different value is the same failure wearing a
       disguise — `Description: null` on a purchase order the ERP describes is
       exactly what the owner saw.

       `Ref` and `UDF.SONo` name the SOURCE order (docs/bugs/0926); the transfer
       fixture has one and the create control none, so they are left out. */
    const sans = (u: unknown) => ({ ...(u as Record<string, unknown>), SONo: undefined });
    for (const key of ['DocNo', 'DocDate', 'CreditorCode', 'CreditorName', 'Agent', 'Description']) {
      expect(transferred[key], `${key} on the transfer`).toEqual(created[key]);
    }
    expect(sans(transferred.UDF), 'UDF on the transfer').toEqual(sans(created.UDF));
  });

  test('the header PURCHASE LOCATION reaches both arms — AutoCount has one and the ERP has one', async () => {
    /* THE ERP'S COUNTERPART is `scm.purchase_orders.purchase_location_id`, the
       per-PO ship-to warehouse that /submit REFUSES a purchase order without
       (mfg-purchase-orders.ts:1125). AutoCount's is `PurchaseLocation`, and
       `PurchaseHeader`'s own comment says it "has never been sent" — which is
       why the book was defaulting it. Owner 2026-08-19: 「它的 Purchase
       Location 也不对」.

       BOTH ROUTES ARE ASSERTED, because the purchase side does NOT share one
       header function: `CreatePo` sets its own master and `PurchaseHeader` is
       what /so-to-po and the four conversions apply. Reading only
       PurchaseHeader would have passed while /create-po silently ignored the
       key — the same "carrying is not landing" trap as Agent below, and the
       first draft of this fix walked into it. */
    expect(headerKeys(CS_CREATE_PO), 'the create route reads it').toContain('PurchaseLocation');
    expect(headerKeys(CS_PURCHASE_HEADER), 'the transfer route reads it').toContain('PurchaseLocation');

    const c = createPoSb();
    await enqueue(c);
    expect(storedBody(c).PurchaseLocation, 'the create arm').toBe('KL');

    const t = soToPoSb();
    await enqueue(t);
    expect(storedBody(t).PurchaseLocation, 'the transfer arm').toBe('KL');
  });

  test('the transfer\'s Details are the DtlKey override shape, and every key is one phase two applies', async () => {
    const t = soToPoSb();
    await enqueue(t);
    const details = storedBody(t).Details as Array<Record<string, unknown>>;
    expect(details).toHaveLength(1);
    expect(details[0].DtlKey, 'the AutoCount sales line this purchase line buys').toBe(4242);

    const applied = new Set(detailKeys(CS_SO_TO_PO));
    expect(Object.keys(details[0]).filter((k) => !applied.has(k))).toEqual([]);
  });

  test('and NO key is sent that the /so-to-po route does not read', async () => {
    const t = soToPoSb();
    await enqueue(t);
    const read = new Set([...headerKeys(CS_SO_TO_PO), ...headerKeys(CS_PURCHASE_HEADER)]);
    const unread = Object.keys(storedBody(t)).filter((k) => !read.has(k) && k !== 'UDF');
    expect(unread, `keys the host would silently drop: ${unread.join(', ')}`).toEqual([]);
  });

  test('a misaligned transfer REFUSES with a row an operator can read, not silently', async () => {
    const t = soToPoSb();
    t.tables.mfg_sales_order_items[1].id = 'so-item-2';
    t.tables.mfg_sales_order_items[1].linked_ac_dtlkey = 4343;
    t.tables.mfg_sales_order_items[2].id = 'so-item-3';
    t.tables.mfg_sales_order_items[2].linked_ac_dtlkey = 4344;
    t.tables.purchase_order_items = [
      {
        id: 'po-item-2', purchase_order_id: 'po-uuid-1', so_item_id: 'so-item-2',
        item_code: 'ANNSA-1B(LHF)', item_group: 'sofa', description: 'SOFA ANNSA',
        description2: 'FABRIC HR805-30', qty: 1, unit_price_sen: 90_000,
        variants: { buildKey: 'build-1', cellIndex: 0 }, warehouse_id: 'wh-kl',
        delivery_date: null, linked_ac_dtlkey: 555,
      },
      {
        id: 'po-item-3', purchase_order_id: 'po-uuid-1', so_item_id: 'so-item-3',
        item_code: 'ANNSA-CNR', item_group: 'sofa', description: 'SOFA ANNSA',
        description2: 'FABRIC HR805-30', qty: 1, unit_price_sen: 90_000,
        variants: { buildKey: 'build-1', cellIndex: 1 }, warehouse_id: 'wh-kl',
        delivery_date: null, linked_ac_dtlkey: null,
      },
    ];
    t.tables.supplier_material_bindings = [{
      item_code: 'ANNSA-1S', supplier_id: 'supplier-uuid-1', supplier_sku: 'AC-ANNSA',
      is_main_supplier: true, material_kind: 'mfg_product', company_id: 1,
    }];

    const outcome = await enqueue(t);
    expect(outcome.queued, 'nothing is queued for AutoCount').toBe(false);
    expect(outcome.problems, 'the operator gets a sentence, not silence').toHaveLength(1);
    expect(outcome.problems[0].message).toContain('has NOT reached the accounts');
    expect(outcome.problems[0].message, 'and it ends in a next step').toContain('re-raise the');
    const rows = t.tables.autocount_outbox;
    expect(rows).toHaveLength(1);
    expect(rows[0].status, 'a refusal, not a retry').toBe('skipped');
    expect(String(rows[0].last_error), 'the class name, so the remedy is findable')
      .toContain('AcSoToPoAlignmentError');
    expect(String(rows[0].last_error), 'and the two counts').toContain('2 source line(s)');
    expect(rows[0].payload, 'nothing that could be POSTed').toEqual({ body: {} });
  });

  test('the AGENT the transfer now sends is one PurchaseHeader actually assigns', () => {
    expect(headerKeys(CS_PURCHASE_HEADER)).toContain('Agent');
  });
});

describe('the four conversions', () => {
  const convert = async (op: any, docType: any, from: any, to: any, docNo: string) => {
    const sb = seeded();
    sb.tables[from.table][0].linked_ac_docno = 'AC-PARENT-1';
    expect((await enqueueConvert(sb as never, { companyId: 1, op, from, to, docType, docNo })).queued).toBe(true);
    return wireBody(sb);
  };


  const PURCHASE_CONVERSIONS = [
    ['po_to_gr', 'GR',
      { table: 'purchase_orders', keyCol: 'id', key: 'po-uuid-1' },
      { table: 'grns', keyCol: 'id', key: 'grn-uuid-1' }, 'GRN-2608-003'],
    ['gr_to_pi', 'PI',
      { table: 'grns', keyCol: 'id', key: 'grn-uuid-1' },
      { table: 'purchase_invoices', keyCol: 'id', key: 'pi-uuid-1' }, 'PI-2608-002'],
  ] as Array<[any, any, any, any, string]>;

  test('all four conversions put their account on the wire — D15 closed', async () => {
    for (const [op, docType, from, to, docNo] of [
      ['so_to_do', 'DO',
        { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
        { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' }, 'DO-2608-009'],
      ['do_to_iv', 'IV',
        { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
        { table: 'sales_invoices', keyCol: 'id', key: 'si-uuid-1' }, 'SI-2608-002'],
    ] as Array<[any, any, any, any, string]>) {
      const body = await convert(op, docType, from, to, docNo);
      expect(body.DebtorCode, `${op} must name the customer`).toBe(AC_DEBTOR_CODE);
      expect(Object.keys(body), `${op} has no creditor`).not.toContain('CreditorCode');
    }

    for (const [op, docType, from, to, docNo] of PURCHASE_CONVERSIONS) {
      const body = await convert(op, docType, from, to, docNo);
      expect(body.CreditorCode, `${op} must name the supplier`).toBe(SUPPLIER.code);
      expect(body.CreditorName, `${op} names it too`).toBe(SUPPLIER.name);
      expect(Object.keys(body), `${op} must not send a DEBTOR`).not.toContain('DebtorCode');
    }
  });

  /* THE ROW ALREADY IN THE QUEUE — the same half of the fix `so_to_po` needed in
     #2345, and needed here for the same mechanical reason: `dispatchOne` REPLAYS
     the stored payload and never recomposes, so an enqueue-only fix leaves every
     row queued before it going out with no account for ever.

     It is belt-and-braces here rather than the only answer — the source of a
     purchase conversion IS in the account book, so the service can read the
     creditor off it — and it is still worth having, because a value the ERP
     STATES cannot be wrong about which row the service happened to read. */
  test('a purchase conversion stored WITHOUT a creditor is backfilled at drain', async () => {
    for (const [op, docType, from, to, docNo] of PURCHASE_CONVERSIONS) {
      const sb = seeded();
      sb.tables[from.table][0].linked_ac_docno = 'AC-PARENT-1';
      await enqueueConvert(sb as never, { companyId: 1, op, from, to, docType, docNo });
      const row = sb.tables.autocount_outbox[0];
      delete (row.payload as any).body.CreditorCode;
      delete (row.payload as any).body.CreditorName;

      const body = await wireBody(sb);
      expect(body.CreditorCode, `${op} resolved at drain, so no requeue is needed`)
        .toBe(SUPPLIER.code);
    }
  });

  test('the drain backfill does NOT overwrite a creditor the payload already names', async () => {
    const [op, docType, from, to, docNo] = PURCHASE_CONVERSIONS[0];
    const sb = seeded();
    sb.tables[from.table][0].linked_ac_docno = 'AC-PARENT-1';
    await enqueueConvert(sb as never, { companyId: 1, op, from, to, docType, docNo });
    (sb.tables.autocount_outbox[0].payload as any).body.CreditorCode = '400-OTHER';
    const body = await wireBody(sb);
    expect(body.CreditorCode).toBe('400-OTHER');
  });

  test('no supplier row means NO CreditorCode key, not a blank one', async () => {
    const [op, docType, from, to, docNo] = PURCHASE_CONVERSIONS[0];
    const sb = seeded();
    sb.tables[from.table][0].linked_ac_docno = 'AC-PARENT-1';
    sb.tables.suppliers = [];
    await enqueueConvert(sb as never, { companyId: 1, op, from, to, docType, docNo });
    const body = await wireBody(sb);
    expect(Object.keys(body)).not.toContain('CreditorCode');
  });

  test('a conversion whose parent has no AutoCount number waits, and posts nothing', async () => {
    const sb = seeded();
    await enqueueConvert(sb as never, {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'DO-2608-009',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
    });
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}', { status: 200 }); }) as never;
    const row = sb.tables.autocount_outbox[0] as AcOutboxRow;
    expect(await dispatchOne(ENV, sb as never, row, fetchImpl)).toBe('waiting');
    expect(called).toBe(false);
  });
});

describe('/cancel', () => {
  test.skip('exactly the two fields Cancel reads, and a DocType it understands', async () => {
    const sb = seeded();
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    expect(await enqueueCancel(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'SO-2608-011',
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
    })).toBe(true);

    const body = await wireBody(sb);
    expect(body).toEqual({ DocType: 'SO', DocNo: 'AC-SO-9' });
    expect(Object.keys(body).sort()).toEqual(headerKeys(CS_CANCEL));
    expect(body.DocNo).not.toBe('SO-2608-011');
  });

  test('every doc type the ERP can queue is a case the C# switch handles', () => {
    for (const t of ['SO', 'PO', 'DO', 'IV', 'GR', 'PI']) {
      expect(CS_CANCEL, `Cancel has no case for ${t}`).toContain(`case "${t}":`);
    }
  });
});

describe('/edit', () => {
  test.skip('the envelope, the header, and a line addressed by its AutoCount DtlKey', async () => {
    /* With PR #1819 landed. Without it the line select 42703s and the edit goes
       over with NO Lines at all — the same D13 the create path has, asserted at
       the end of this block. */
    const sb = seeded();
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'SO-2608-011' })).toBe(true);

    const body = await wireBody(sb);
    expect(body.DocType).toBe('SO');
    expect(body.DocNo).toBe('AC-SO-9');
    expect(body.Header).toEqual({
      DebtorName: 'Tan Ah Kow',
      Attention: 'Tan Ah Kow',
      Ref: 'WALK-IN',
      Phone1: '0123456789',
      InvAddr1: 'No 1 Jalan Trial',
      InvAddr2: 'Taman Trial',
      InvAddr3: '47800 Petaling Jaya',
      InvAddr4: 'Selangor',
    });
    const allow = new Set(csEditHeaderAllowList());
    expect(Object.keys(body.Header as object).filter((k) => !allow.has(k))).toEqual([]);

    const lines = body.Lines as Record<string, unknown>[];
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({
      DtlKey: 4242,
      ItemCode: 'AKEMI-SOLITUDE-Q',
      Description: 'AKEMI SOLITUDE MATTRESS QUEEN',
      Desc2: 'QUEEN 5x6.5',
      Qty: 1,
      UnitPrice: 1999,
      Location: null,
      DeliveryDate: null,
    });
    expect(lines.slice(1).every((l) => !('DtlKey' in l))).toBe(true);
    const lineRead = new Set(detailKeys(CS_EDIT));
    for (const l of lines) expect(Object.keys(l).filter((k) => !lineRead.has(k))).toEqual([]);
    expect(CS_EDIT.indexOf('d.ItemCode')).toBeGreaterThan(CS_EDIT.indexOf('d = doc.AddDetail();'));
    expect(CS_EDIT.indexOf('d.ItemCode')).toBeLessThan(CS_EDIT.indexOf('it.ContainsKey("Description")'));
  });

  test('D13 struck on the edit path too: a failed line read queues no edit at all', async () => {
    const sb = seeded({ mfg_sales_order_items: ['linked_ac_dtlkey'] });
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'SO-2608-011' })).toBe(false);
    const rows = sb.tables.autocount_outbox;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows.some((r) => Array.isArray((r.payload as any)?.body?.Lines))).toBe(false);
  });

  test('D8: the fields /edit would apply and the ERP never sends', () => {
    const allow = csEditHeaderAllowList();
    for (const f of ['Agent', 'SalesLocation', 'Description', 'Remark2']) {
      expect(allow, `the C# allow-list is missing ${f}`).toContain(f);
    }
  });

  test('linked_ac_dtlkey IS in the schema now (migration 0273), on both item tables', () => {
    expect(schemaOf('mfg_sales_order_items').has('linked_ac_dtlkey')).toBe(true);
    expect(schemaOf('purchase_order_items').has('linked_ac_dtlkey')).toBe(true);
  });
});


describe('the divergence register', () => {
  test('every entry names a field, both sides and a cost', () => {
    expect(DIVERGENCES.length).toBeGreaterThan(0);
    const ids = DIVERGENCES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DIVERGENCES) {
      expect(d.field.length, d.id).toBeGreaterThan(0);
      expect(d.service.length, d.id).toBeGreaterThan(40);
      expect(d.erp.length, d.id).toBeGreaterThan(40);
    }
  });

  test('the count is pinned — a new divergence has to be written down to land', () => {
    /* If this fails you have either found a new one or fixed one of these.
       Both are good news; update the list and the module guide's prose together
       — 7b for D9/D10, 7c1 for D14, 7c4 for D16, 7c3 for the struck D15, 7c3a
       and 7c3b for the struck D5, 7d2 for
       D8, 7q for the extract's own fields.

       Started at thirteen. D11 and D13 were struck off when #1855 fixed them,
       D3 (the line delivery date) on 2026-08-15 and D5 (the document number) on
       2026-08-17 — all four were plain bugs, not decisions; the ones that remain
       each need one.

       D14 was ADDED on 2026-08-17. It is not new behaviour — the service has
       always transferred a line at its outstanding quantity — it is a gap that
       had never been written down anywhere a check could see it, and the owner
       asked for both transfer shapes the day before. The C# half is done: the
       decision lives in one place (PlanTransfer) and a quantity it cannot
       express is refused, not approximated. The ERP half is a payload change
       and a decision about where the shipped quantity comes from, which is not
       a test author's to make.

       D15 was ADDED on 2026-08-17 morning, the day after D14 and for a harder
       reason: it was the PROVEN cause of a week-long production outage, measured
       on the host rather than argued from source. It was STRUCK the same night —
       the shortest life on this register — when the purchase half turned out to
       need no join at all and `po_to_gr` started working. Striking it did NOT
       delete the service's book fallback; read the note where the entry used to
       be before assuming otherwise.

       D16 was ADDED the same night, and it is the price of that fix rather than
       a separate discovery: the only call that moves a purchase conversion into
       this book is FullTransfer, and FullTransfer cannot take a subset. So the
       ERP names the lines correctly and the service transfers all of them. It
       is registered at HIGH because the cost lands in a licensed account book,
       and it is not "fixed" by refusing, because refusing is the state
       /po-to-gr spent a week in. Closing it needs the host: either
       AddPartialTransferDetail works now that the target has a creditor (never
       retested since), or the named set has to be compared against the source's
       outstanding lines before FullTransfer is allowed.

       D5 was STRUCK on 2026-08-17. It was the last one on the list that had no
       decision left in it: the account book takes the ERP's number wherever it
       is sent, and `/so-to-po` was the only route still not sending one. It goes
       for the same reason D3 did — a plain bug on the ERP side — and, like D3,
       its absence is now held by tests rather than by prose.

       D4 was STRUCK on 2026-08-20 and D17 ADDED the same day, and the count is
       unchanged because of it. D4 was the four conversions dropping their own
       Ref, Description, supplier document number, date and purchase location;
       it had no decision left in it and the payload now derives from the
       document's own master, so it goes the way D3 and D5 went. D17 is the
       REMAINDER — the part of the same area that IS a decision: the sales arms
       have no location slot in the service at all, and the ERP's delivery order
       carries two note columns with only one of them mapped, so which one is
       the account book's Description is the owner's call and not a test
       author's. Splitting it out is the point: striking D4 whole would have
       filed an open question as fixed. */
    expect(DIVERGENCES).toHaveLength(11);
    expect(DIVERGENCES.filter((d) => d.severity === 'critical').map((d) => d.id))
      .toEqual(['D9', 'D10']);
    expect(DIVERGENCES.map((d) => d.id)).not.toContain('D3');
    expect(DIVERGENCES.map((d) => d.id)).not.toContain('D4');
    expect(DIVERGENCES.map((d) => d.id)).not.toContain('D5');
    expect(DIVERGENCES.map((d) => d.id)).not.toContain('D11');
    expect(DIVERGENCES.map((d) => d.id)).not.toContain('D13');
    expect(DIVERGENCES.map((d) => d.id)).not.toContain('D15');
  });
});


describe('the test-book trial payloads are the same contract', () => {
  const readKeysFor: Record<string, { header: string[]; detail: string[] }> = {
    '/create-so': { header: headerKeys(CS_CREATE_SO), detail: detailKeys(CS_CREATE_SO) },
    '/create-po': { header: headerKeys(CS_CREATE_PO), detail: detailKeys(CS_CREATE_PO) },
    '/so-to-do': { header: [...headerKeys(CS_CONVERT), ...headerKeys(CS_DTLKEYS), ...headerKeys(CS_SALES_HEADER)], detail: [] },
    '/do-to-iv': { header: [...headerKeys(CS_CONVERT), ...headerKeys(CS_DTLKEYS), ...headerKeys(CS_SALES_HEADER)], detail: [] },
    '/po-to-gr': { header: [...headerKeys(CS_CONVERT), ...headerKeys(CS_DTLKEYS), ...headerKeys(CS_PURCHASE_HEADER)], detail: [] },
    '/gr-to-pi': { header: [...headerKeys(CS_CONVERT), ...headerKeys(CS_DTLKEYS), ...headerKeys(CS_PURCHASE_HEADER)], detail: [] },
    '/cancel': { header: headerKeys(CS_CANCEL), detail: [] },
    '/edit': { header: headerKeys(CS_EDIT), detail: detailKeys(CS_EDIT) },
  };

  test('every key in trial-payloads.json is a key AcSyncService.cs reads', () => {
    for (const step of trialPayloads.steps as Array<Record<string, any>>) {
      const spec = readKeysFor[step.route];
      expect(spec, `unknown route in trial-payloads.json: ${step.route}`).toBeTruthy();
      const header = new Set([...spec.header, 'UDF']);
      expect(
        Object.keys(step.payload).filter((k) => !header.has(k)),
        `${step.id} sends a header key the service does not read`,
      ).toEqual([]);
      for (const d of (step.payload.Details ?? step.payload.Lines ?? []) as Record<string, unknown>[]) {
        expect(
          Object.keys(d).filter((k) => !spec.detail.includes(k)),
          `${step.id} sends a line key the service does not read`,
        ).toEqual([]);
      }
    }
  });

  test('the probe that settles D1 sends both spellings, so one look at the book decides it', () => {
    const probe = (trialPayloads.steps as Array<Record<string, any>>).find((s) => s.id === 'udf-probe');
    expect(probe).toBeTruthy();
    expect(Object.keys(probe!.payload.UDF).sort())
      .toEqual(['BRANDING', 'SOUDF_BRANDING', 'SOUDF_ToPONo', 'ToPONo']);
  });

  test('nothing in the payload set points at a production document number', () => {
    const json = JSON.stringify(trialPayloads.steps);
    for (const m of json.matchAll(/"DocNo":\s*"([^"@]+)"/g)) {
      expect(m[1], 'a trial document number must be obviously a trial').toMatch(/^TRIAL-/);
    }
  });
});


describe('mutation proof — each field is load-bearing', () => {
  function paths(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
    if (Array.isArray(value)) return value.flatMap((v, i) => paths(v, [...prefix, i]));
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) => paths(v, [...prefix, k]));
    }
    return [prefix];
  }

  function without(body: unknown, path: Array<string | number>): unknown {
    const copy: any = structuredClone(body);
    let node = copy;
    for (const step of path.slice(0, -1)) node = node[step];
    const last = path[path.length - 1];
    if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete node[last];
    return copy;
  }

  test('drop any one field of the /create-so body and the contract assertion fails', async () => {
    const sb = seeded();
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' });
    const body = await wireBody(sb);
    const all = paths(body);
    expect(all.length).toBeGreaterThan(40);
    for (const p of all) {
      expect(
        () => expect(without(body, p)).toEqual(body),
        `removing ${p.join('.')} from the /create-so body did NOT fail the assertion`,
      ).toThrow();
    }
  });

  test('the same for /cancel, /edit and a conversion', async () => {
    const sb = seeded();
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    await enqueueCancel(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'SO-2608-011',
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
    });
    const cancel = await wireBody(sb);
    for (const p of paths(cancel)) {
      expect(() => expect(without(cancel, p)).toEqual(cancel), p.join('.')).toThrow();
    }

    const sb2 = seeded();
    sb2.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    await enqueueEdit(sb2 as never, { companyId: 1, docType: 'SO', docNo: 'SO-2608-011' });
    const edit = await wireBody(sb2);
    for (const p of paths(edit)) {
      expect(() => expect(without(edit, p)).toEqual(edit), p.join('.')).toThrow();
    }

    const sb3 = seeded();
    sb3.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-PARENT-1';
    await enqueueConvert(sb3 as never, {
      companyId: 1, op: 'so_to_do', docType: 'DO', docNo: 'DO-2608-009',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
      to: { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
    });
    const conv = await wireBody(sb3);
    for (const p of paths(conv)) {
      expect(() => expect(without(conv, p)).toEqual(conv), p.join('.')).toThrow();
    }
  });

  test('rename any key the C# reads and layer 1 catches it', () => {
    const renamed = acSyncSource.replace('Str(p, "DebtorCode")', 'Str(p, "AccountCode")');
    const keys = [...renamed.slice(
      renamed.indexOf('static string CreateSo('),
      renamed.indexOf('static string CreatePo('),
    ).matchAll(/(?:Str|Dec|Date|Dict|List)\(\s*p\s*,\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    expect(keys).toContain('AccountCode');
    expect(keys).not.toContain('DebtorCode');
  });
});

/* ── The eleven skips, bounded ────────────────────────────────────────────────
   Eleven assertions in this file are `test.skip` as of 2026-08-14. They are NOT
   wrong-and-abandoned: they are the ones that went red when main changed BOTH
   sides of the contract under them (#2041/#2043 reworked AcSyncService.cs, and
   the TS composer moved with it). Reconciling them means deciding what the
   CURRENT write-back contract IS — DocNo vs FromDocNo on the four conversions,
   what /cancel now reads, the supplier-code field on a PO create — and that is
   exactly what this PR's test-book trial exists to establish. Guessing eleven
   assertions on a financial integration would defeat the file's purpose.

   The other 24 assertions in here RUN, and they protect the parts that did not
   move. That is the trade: partial protection now, beats none until someone has
   a live book.

   THIS TEST IS THE FENCE. It reads its own source and fails if the number of
   skips changes. Going UP means a new drift was hidden instead of reported;
   going DOWN means one was reconciled and this number must come with it. Either
   way it is a deliberate edit, not a silent slide — which is the failure mode a
   skipped test otherwise has by construction.

   Re-enable by running the trial against a real AutoCount test book, recording
   what it actually accepts, and deleting the `.skip` one at a time. */
describe('/health reports the build that is answering', () => {
  test('it returns builtAt and mvid, not just the book name', () => {
    const health = rawAcSync.slice(
      rawAcSync.indexOf('static Dictionary<string, object> Health()'),
      rawAcSync.indexOf('static void Handle(HttpListenerContext ctx)'),
    );
    expect(
      health.length,
      'Health() was removed or renamed — /health can no longer say which build is running.',
    ).toBeGreaterThan(0);

    expect(health).toContain('File.GetLastWriteTimeUtc');
    expect(health).toContain('"builtAt"');
    expect(health).toContain('ModuleVersionId');
    expect(health).toContain('"mvid"');
  });

  test('a host that cannot read its own assembly still answers, with nulls', () => {
    const health = rawAcSync.slice(
      rawAcSync.indexOf('static Dictionary<string, object> Health()'),
      rawAcSync.indexOf('static void Handle(HttpListenerContext ctx)'),
    );
    expect(health).toContain('catch');
    expect(health).toMatch(/h\["builtAt"\]\s*=\s*null/);
    expect(health).toMatch(/h\["mvid"\]\s*=\s*null/);
  });
});

describe('the skipped assertions stay bounded', () => {
  test('exactly seven assertions are skipped, and no more', () => {
    const skips = selfSource.match(/\btest\.skip\(/g) ?? [];
    expect(
      skips.length,
      'A skip was added or removed without updating this fence. Adding one hides a ' +
        'contract drift instead of reporting it; removing one is progress and belongs ' +
        'in the same commit as this number.',
    ).toBe(7);
  });
});
