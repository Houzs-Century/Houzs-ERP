// ----------------------------------------------------------------------------
// ERP -> AutoCount: THE PAYLOAD CONTRACT.
//
// Two programs have to agree on one JSON document and they are written in
// different languages, live in different repositories at run time, and are
// deployed by different people. Nothing checks that agreement — AcSyncService
// reads a key with Str(p, "X"), and a key that is not there comes back as ""
// (AcSyncService.cs:427) rather than as an error. A renamed field is therefore
// not a crash: it is a document quietly written to a live account book with a
// blank where the customer's address used to be.
//
// So this file does not test the composer against itself. It reads
// AcSyncService.cs — the real one, at build time, via ?raw — extracts the keys
// that file ACTUALLY parses, and holds the ERP's payload up against them.
//
// Three layers, each of which fails on its own:
//
//   1. EXTRACTION      what AcSyncService.cs reads, pulled out of its source and
//                      compared with a checked-in list. Rename a field in the C#
//                      and this fails first, naming the field.
//   2. WIRE BODY       the bytes dispatchOne would POST, for all eight routes,
//                      asserted whole against a fixture built from layer 1.
//   3. DIVERGENCES     where the two sides do NOT agree. Each one is registered
//                      with the field, both sides, and what it costs. The test
//                      fails if a new divergence appears AND if a registered one
//                      is fixed without removing it from the list — so the list
//                      cannot rot in either direction.
//
// It also runs the ERP's OWN SCHEMA over the queries: the fake PostgREST below
// refuses a column that scm's schema dump does not have, exactly as the real one
// does with 42703. That is what catches a write-back that selects a column that
// was never there.
//
// Everything here runs with no AutoCount, no network and no database.
// ----------------------------------------------------------------------------
import { describe, expect, test, beforeEach } from 'vitest';
import rawAcSync from '../../scripts/autocount-service/AcSyncService.cs?raw';
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
import { resetWritebackFlagCache } from '../scm/lib/autocount-writeback-flag';

/* ?raw hands back the WORKING TREE bytes, which on Windows are CRLF. Normalise,
   or every anchor and every regex here means something different depending on
   whose machine ran it. */
const acSyncSource = rawAcSync.replace(/\r\n/g, '\n');
const scmSchemaSql = rawScmSchema.replace(/\r\n/g, '\n');

// ── layer 1: what AcSyncService.cs actually parses ──────────────────────────

/** A method body, sliced out of the C# by two anchors that exist in the file. */
function slice(from: string, to: string): string {
  const a = acSyncSource.indexOf(from);
  expect(a, `AcSyncService.cs anchor missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = acSyncSource.indexOf(to, a + from.length);
  expect(b, `AcSyncService.cs anchor missing after ${from}: ${to}`).toBeGreaterThan(a);
  return acSyncSource.slice(a, b);
}

/** Keys read off a JSON object in C#: Str(p,"X") / Dec(it,"X",0) / Date / Dict / List. */
const keysRead = (body: string, bag: string): string[] => {
  const out = new Set<string>();
  const re = new RegExp(`(?:Str|Dec|Date|Dict|List)\\(\\s*${bag}\\s*,\\s*"([A-Za-z0-9_]+)"`, 'g');
  for (const m of body.matchAll(re)) out.add(m[1]);
  // `it.ContainsKey("X")` guards on the edit path, and it["DtlKey"].
  for (const m of body.matchAll(new RegExp(`${bag}\\.ContainsKey\\("([A-Za-z0-9_]+)"\\)`, 'g'))) out.add(m[1]);
  for (const m of body.matchAll(new RegExp(`${bag}\\["([A-Za-z0-9_]+)"\\]`, 'g'))) out.add(m[1]);
  return [...out].sort();
};

const CS_CREATE_SO = slice('static string CreateSo(', 'static string CreatePo(');
const CS_CREATE_PO = slice('static string CreatePo(', '// ── conversions');
const CS_CONVERT = slice('static string Convert_(', "/* The SDK's over-transfer dialog");
const CS_SALES_HEADER = slice('static void SalesHeader(', 'static void PurchaseHeader(');
const CS_PURCHASE_HEADER = slice('static void PurchaseHeader(', '/* Source line keys');
const CS_DTLKEYS = slice('static long[] DtlKeys(', '// ── cancel');
const CS_CANCEL = slice('static void Cancel(', '// ── edit');
const CS_EDIT = slice('static void Edit(', '// ── helpers');
const CS_APPLY_UDF = slice('static void ApplyUdf(', 'static Dictionary<string, object> Ok(');

/** The header allow-list the edit path iterates — the only header fields /edit
 *  will ever apply. Anything outside it is read from the payload and dropped. */
const csEditHeaderAllowList = (): string[] => {
  const block = CS_EDIT.slice(CS_EDIT.indexOf('new string[] {'), CS_EDIT.indexOf('}) {'));
  return [...block.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort();
};

/** Detail keys, from the loop bodies (the per-line bag is always `it`). */
const detailKeys = (body: string) => keysRead(body, 'it');
/** Header keys, from a method whose payload bag is `p` (or `h` on the edit). */
const headerKeys = (body: string, bag = 'p') => keysRead(body, bag);

describe('layer 1 — the keys AcSyncService.cs parses, read out of its source', () => {
  test('/create-so', () => {
    expect(headerKeys(CS_CREATE_SO)).toEqual([
      'Attention', 'Agent', 'DebtorCode', 'DebtorName', 'DeliverAddr1', 'DeliverAddr2',
      'DeliverAddr3', 'DeliverAddr4', 'DeliverContact', 'DeliverPhone1', 'Details',
      'DocDate', 'DocNo', 'InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4', 'Phone',
      'Ref', 'SalesLocation',
    ].sort());
    expect(detailKeys(CS_CREATE_SO)).toEqual(
      ['DeliveryDate', 'Desc2', 'Description', 'ItemCode', 'Location', 'Qty', 'UnitPrice'].sort(),
    );
  });

  test('/create-po', () => {
    expect(headerKeys(CS_CREATE_PO)).toEqual(
      ['Agent', 'CreditorCode', 'CreditorName', 'Description', 'Details', 'DocDate', 'DocNo', 'Ref'].sort(),
    );
    expect(detailKeys(CS_CREATE_PO)).toEqual(
      ['DeliveryDate', 'Desc2', 'Description', 'ItemCode', 'Location', 'Qty', 'UnitPrice'].sort(),
    );
  });

  test('the four conversions, and the two header fields only one of them reads', () => {
    expect(headerKeys(CS_CONVERT)).toEqual(
      ['FromDocNo', 'SupplierDONo', 'SupplierInvoiceNo'].sort(),
    );
    /* DtlKeys is optional and read in its own helper: given none, the service
       asks the BOOK which lines are still outstanding (AcSyncService.cs:300-329),
       which is the only authority on that. */
    expect(headerKeys(CS_DTLKEYS)).toEqual(['DtlKeys']);
    // Shared header handling — identical on the sales and purchase side.
    expect(headerKeys(CS_SALES_HEADER)).toEqual(['Description', 'DocDate', 'DocNo', 'Ref'].sort());
    expect(headerKeys(CS_PURCHASE_HEADER)).toEqual(['Description', 'DocDate', 'DocNo', 'Ref'].sort());
  });

  test('/cancel takes exactly two fields', () => {
    expect(headerKeys(CS_CANCEL)).toEqual(['DocNo', 'DocType']);
  });

  test('/edit — the envelope, the header allow-list, and the line fields', () => {
    expect(headerKeys(CS_EDIT)).toEqual(['DocNo', 'DocType', 'Header', 'Lines'].sort());
    expect(headerKeys(CS_EDIT, 'h')).toEqual(['DocDate']);
    expect(csEditHeaderAllowList()).toEqual([
      'Agent', 'Attention', 'CreditorName', 'DebtorName', 'DeliverAddr1', 'DeliverAddr2',
      'DeliverAddr3', 'DeliverAddr4', 'DeliverContact', 'DeliverPhone1', 'Description',
      'InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4', 'Note', 'Phone1', 'Ref',
      'Remark1', 'Remark2', 'Remark3', 'Remark4', 'SalesLocation',
    ].sort());
    expect(detailKeys(CS_EDIT)).toEqual(
      ['DeliveryDate', 'Desc2', 'Description', 'DtlKey', 'ItemCode', 'Location', 'Qty', 'UnitPrice'].sort(),
    );
  });

  test('UDF is a free-form dictionary the service writes key-for-key, and swallows a bad key', () => {
    expect(headerKeys(CS_APPLY_UDF)).toEqual(['UDF']);
    /* THE reason the UDF field NAMES cannot be settled from source: every write
       goes through Set(), which catches and logs instead of throwing. A key the
       book does not have is a silent no-op, not an error. */
    expect(CS_APPLY_UDF).toContain('Set(() => set(k, v));');
    expect(acSyncSource).toContain('static void Set(Action a) { try { a(); } catch (Exception ex) { Log("  set skipped: " + ex.Message); } }');
  });

  test('a MISSING key and a NULL key are the same thing to this service, and both mean ""', () => {
    /* Str() is the whole reason an omitted optional field is not "leave it
       alone" but "write an empty string over whatever is there". Every
       divergence below that talks about blanking rests on this one line. */
    expect(acSyncSource).toContain(
      'static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }',
    );
  });
});

// ── the ERP schema, so a query cannot select a column that is not there ──────

/** Column lists straight out of the scm schema dump (the CREATE side; the
 *  migrations only ALTER). Anything a later migration added is listed below it
 *  with the migration that added it — those are the only two sources there are. */
function columnsOf(table: string): string[] {
  const head = `CREATE TABLE "${table}" (`;
  const a = scmSchemaSql.indexOf(head);
  expect(a, `no CREATE TABLE for ${table} in the scm schema dump`).toBeGreaterThanOrEqual(0);
  const body = scmSchemaSql.slice(a + head.length, scmSchemaSql.indexOf('\n);', a));
  return [...body.matchAll(/^\s*"([a-z0-9_]+)"\s+/gm)].map((m) => m[1]);
}

const LATER_MIGRATIONS: Record<string, string[]> = {
  // 0083 (company_id), 0271 (linked_ac_docno)
  mfg_sales_orders: ['company_id', 'linked_ac_docno'],
  // 0083 (company_id). linked_ac_dtlkey belongs to PR #1819 and is NOT merged.
  mfg_sales_order_items: ['company_id'],
  // 0026, 0080, 0083, 0144, 0275, 0277
  purchase_orders: [
    'supplier_delivery_date_2', 'supplier_delivery_date_3', 'supplier_delivery_date_4',
    'revision', 'company_id', 'po_email_sent_at', 'po_email_sent_to',
    'linked_ac_grn_docnos', 'linked_ac_pinv_docnos', 'linked_ac_docno',
  ],
  purchase_order_items: ['company_id'],
};

/** What PR #1819 (migration 0273) adds and has not landed yet. */
const PR_1819: Record<string, string[]> = {
  mfg_sales_order_items: ['linked_ac_dtlkey'],
  purchase_order_items: ['linked_ac_dtlkey'],
};

const schemaOf = (table: string, withPr1819 = false): Set<string> =>
  new Set([
    ...columnsOf(table),
    ...(LATER_MIGRATIONS[table] ?? []),
    ...(withPr1819 ? PR_1819[table] ?? [] : []),
  ]);

type Row = Record<string, any>;

/**
 * PostgREST stand-in that ALSO enforces the schema. `select('a, b, c')` on a
 * table whose column list is known answers 42703 for an unknown column, exactly
 * as Supabase does — which is the only way a test can catch a write-back that
 * reads a column the ERP has never had.
 */
function fakeSb(tables: Record<string, Row[]>, withPr1819 = false) {
  const schemas: Record<string, Set<string>> = {
    mfg_sales_orders: schemaOf('mfg_sales_orders', withPr1819),
    mfg_sales_order_items: schemaOf('mfg_sales_order_items', withPr1819),
    purchase_orders: schemaOf('purchase_orders', withPr1819),
    purchase_order_items: schemaOf('purchase_order_items', withPr1819),
  };
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let columnError: { code: string; message: string } | null = null;
    const rows = () => {
      const rs = tables[table].filter((r) => filters.every((f) => f(r)));
      return limitN == null ? rs : rs.slice(0, limitN);
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
      lt(col: string, val: unknown) { filters.push((r) => Number(r[col] ?? 0) < Number(val)); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => (columnError ? { data: null, error: columnError } : { data: rows()[0] ?? null, error: null }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return builder;
  };
  return { from, tables } as never as { from: (t: string) => any; tables: Record<string, Row[]> };
}

// ── a realistic ERP document ────────────────────────────────────────────────

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

/* One mattress, one THREE-MODULE SOFA BUILD (the rows share variants.buildKey —
   scm/shared/so-sofa-split.ts:83 splits one sold sofa into one row per
   compartment, each qty 1 with a share of the price), and one service line. */
const SO_ITEMS = [
  {
    doc_no: 'SO-2608-011', item_code: 'AKEMI-SOLITUDE-Q', item_group: 'mattress',
    description: 'AKEMI SOLITUDE MATTRESS QUEEN', description2: 'QUEEN 5x6.5',
    qty: 1, unit_price_centi: 199_900, discount_centi: 0, variants: null,
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-01',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'ANNSA-1B(LHF)', item_group: 'sofa',
    description: 'SOFA ANNSA', description2: null,
    qty: 1, unit_price_centi: 150_000, discount_centi: 30_000,
    variants: { buildKey: 'build-1', cellIndex: 0, fabricColor: 'HR805-30', fabricLabel: 'Linen' },
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-15',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'ANNSA-CNR', item_group: 'sofa',
    description: 'SOFA ANNSA', description2: null,
    qty: 1, unit_price_centi: 150_000, discount_centi: 0,
    variants: { buildKey: 'build-1', cellIndex: 1, fabricColor: 'HR805-30', fabricLabel: 'Linen' },
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-15',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'ANNSA-2A(RHF)', item_group: 'sofa',
    description: 'SOFA ANNSA', description2: null,
    qty: 1, unit_price_centi: 150_000, discount_centi: 0,
    variants: { buildKey: 'build-1', cellIndex: 2, fabricColor: 'HR805-30', fabricLabel: 'Linen' },
    location: null, warehouse_id: 'wh-kl', line_delivery_date: '2026-09-15',
  },
  {
    doc_no: 'SO-2608-011', item_code: 'SVC-DELIVERY', item_group: 'service',
    description: 'Delivery', description2: null,
    qty: 1, unit_price_centi: 15_000, discount_centi: 0, variants: null,
    location: null, warehouse_id: null, line_delivery_date: null,
  },
];

/* A purchase order as scm.purchase_orders ACTUALLY is — supplier_id and notes,
   no creditor columns. That is the point of this row; see DIVERGENCES B1. */
const PO_HEADER = {
  id: 'po-uuid-1', po_number: 'PO-2608-004', po_date: '2026-08-11',
  supplier_id: 'supplier-uuid-1', notes: 'Trial purchase order',
  company_id: 1, linked_ac_docno: null,
};

const PO_ITEMS = [
  {
    purchase_order_id: 'po-uuid-1', material_code: 'AKEMI-SOLITUDE-Q', item_group: 'mattress',
    description: 'AKEMI SOLITUDE MATTRESS QUEEN', qty: 2, unit_price_centi: 90_000,
    discount_centi: 0, variants: null, warehouse_id: 'wh-kl', delivery_date: '2026-09-20',
  },
];

/**
 * @param withPr1819 give the item tables the linked_ac_dtlkey column PR #1819
 *   adds. FALSE is production today; TRUE is what the write-back was written
 *   for. Both are asserted below, because they produce different payloads.
 */
const seeded = (withPr1819 = false) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: 'all' }],
  autocount_outbox: [],
  mfg_sales_orders: [{ ...SO_HEADER }],
  mfg_sales_order_items: SO_ITEMS.map((r, i) => ({ ...r, linked_ac_dtlkey: i === 0 ? 4242 : null })),
  purchase_orders: [{ ...PO_HEADER }],
  purchase_order_items: PO_ITEMS.map((r) => ({ ...r, linked_ac_dtlkey: null })),
  delivery_orders: [{ id: 'do-uuid-1', do_number: 'DO-2608-009', linked_ac_docno: null }],
  grns: [{ id: 'grn-uuid-1', grn_number: 'GRN-2608-003', linked_ac_docno: null }],
  sales_invoices: [{ id: 'si-uuid-1', invoice_number: 'SI-2608-002', linked_ac_docno: null }],
  purchase_invoices: [{ id: 'pi-uuid-1', invoice_number: 'PI-2608-002', linked_ac_docno: null }],
}, withPr1819);

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

// ── layer 3: the divergence register ────────────────────────────────────────

interface Divergence {
  id: string;
  flow: string;
  /** The AutoCount field, as AcSyncService.cs names it. */
  field: string;
  /** What the service needs, and what happens when it does not get it. */
  service: string;
  /** What the ERP sends today. */
  erp: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Every place the two sides do NOT agree. This list is load-bearing: the
 * assertions below are written against it, so adding a divergence without an
 * entry fails, and fixing one without deleting its entry also fails.
 *
 * It is deliberately a list of FINDINGS, not of fixes. Nothing in this PR
 * changes the write-back's behaviour — the toggle is off, #1855 is unmerged,
 * and each of these needs a decision that is not a test author's to make.
 * docs/modules/autocount-writeback.md section 11 carries the same list in prose
 * with the decision each one needs.
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
    id: 'D3', flow: 'create_so + create_po', field: 'Details[].DeliveryDate',
    service: 'sets the line delivery date when one is given (AcSyncService.cs:187/214).',
    erp: 'always null. mfg_sales_order_items.line_delivery_date and purchase_order_items.delivery_date both exist and are not selected.',
    severity: 'medium',
  },
  {
    id: 'D4', flow: 'the four conversions', field: 'Ref / Description / SupplierDONo / SupplierInvoiceNo',
    service: 'assigns all four unconditionally on a conversion (AcSyncService.cs:255,265,283-284,291-292); an ABSENT key is "" through Str(), so the transferred document\'s Ref and Description are blanked and a GRN/PI never carries the supplier\'s own document number.',
    erp: 'sends only { DocDate, Ref } and both are null at every call site (autocount-outbox.ts:254; no caller passes docDate or ref).',
    severity: 'high',
  },
  {
    id: 'D5', flow: 'the four conversions', field: 'DocNo',
    service: 'will use the ERP\'s number when one is sent (AcSyncService.cs:282/290) — which is exactly what the two CREATE routes do, so an ERP SO keeps its number in AutoCount.',
    erp: 'never sends it for a conversion, so AutoCount auto-numbers every DO / GRN / invoice and four of the six flows have two different document numbers for one document.',
    severity: 'medium',
  },
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
    erp: 'sends the raw ERP item_code / material_code. makeItemCodeResolver exists and is never called by anything but its own unit test — every compose* call takes the default identityResolver, so no ERP code is ever mapped to an AutoCount one.',
    severity: 'critical',
  },
  {
    id: 'D11', flow: 'create_po + edit(PO)', field: 'CreditorCode / CreditorName / Agent / Ref',
    service: 'assigns CreditorCode unconditionally (AcSyncService.cs:199); a purchase order with a blank creditor cannot be saved.',
    erp: 'selects creditor_code, creditor_name, agent and ref from scm.purchase_orders (autocount-outbox.ts:198,:471). That table has NONE of them — it is supplier-keyed (supplier_id + a join). PostgREST answers 42703, header is null, and both functions return false inside their own try/catch: PO create and PO edit are a silent no-op.',
    severity: 'critical',
  },
  {
    id: 'D12', flow: 'create_so + create_po + edit', field: 'Details[] — line discount',
    service: 'reads no discount field; SalesOrderDetail exposes Discount and DiscountAmt (sdk-api-reference.txt:468) and neither is in the payload contract.',
    erp: 'has discount_centi on both item tables and never sends it, so the AutoCount document total is the undiscounted one. On a sofa the discount sits on ONE compartment row (mfg-sales-orders.ts:4398), which makes it easy to miss.',
    severity: 'high',
  },
  {
    id: 'D13', flow: 'create_so + edit (and every PO flow via D11)', field: 'Details[] / Lines[] — all of them',
    service: 'CreateSo iterates List(p, "Details") (AcSyncService.cs:178); an empty list is an order with no lines.',
    erp: 'selects linked_ac_dtlkey (autocount-outbox.ts:169,:447), a column PR #1819 has not landed. PostgREST does not ignore an unknown column, it fails the whole query with 42703 — so `items` is null, `items ?? []` is empty, and EVERY line is dropped. #1855 describes this state as "every line is new ... correct-but-degraded"; it is every line MISSING.',
    severity: 'critical',
  },
];

// ── layer 2: the wire body, whole, for all eight routes ─────────────────────

describe('/create-so — the body dispatchOne would POST', () => {
  test('D13: as the ERP schema stands TODAY, the order goes over with NO LINES AT ALL', async () => {
    /* The line select asks for linked_ac_dtlkey, which PR #1819 has not landed.
       PostgREST does not ignore an unknown column, it fails the whole query with
       42703 — so `items` is null, `items ?? []` is empty, and the payload is a
       header with an empty Details array. The PR body describes this state as
       "every line is new ... correct-but-degraded"; it is not degraded, it is
       every line MISSING. This is the single most important thing to fix before
       the toggle is ever turned on. */
    const sb = seeded(/* withPr1819 */ false);
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' })).toBe(true);
    const body = await wireBody(sb);
    expect(body.Details).toEqual([]);
    expect(body.DocNo).toBe('SO-2608-011');
  });

  test('every field, against the shape CreateSo parses (with PR #1819 landed)', async () => {
    const sb = seeded(true);
    expect(await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' })).toBe(true);

    expect(await wireBody(sb)).toEqual({
      DocNo: 'SO-2608-011',
      DocDate: '2026-08-11',
      // AcSyncService.cs:160-161 — one fixed account, the real name written over it.
      DebtorCode: '300-C002',
      DebtorName: 'Tan Ah Kow',
      Agent: 'TAN KAR JIUN',
      SalesLocation: 'KL',
      Ref: 'WALK-IN',
      // :165 reads "Phone"; the EDIT path reads "Phone1" for the same column.
      Phone: '0123456789',
      Attention: 'Tan Ah Kow',
      InvAddr1: 'No 1 Jalan Trial',
      InvAddr2: 'Taman Trial',
      InvAddr3: '47800 Petaling Jaya',
      InvAddr4: 'Selangor',
      // D1: the key NAMES are the open question; the shape is right.
      UDF: { BRANDING: 'AKEMI', VENUE: 'KSL CITY MALL JOHOR SOLO', ToPONo: 'CUST-PO-7' },
      Details: [
        {
          ItemCode: 'AKEMI-SOLITUDE-Q',              // D10 — not mapped
          Description: 'AKEMI SOLITUDE MATTRESS QUEEN',
          Desc2: 'QUEEN 5x6.5',
          Qty: 1,
          UnitPrice: 1999,                            // sen -> the decimal AutoCount wants
          Location: null,                             // D2
          DeliveryDate: null,                         // D3
        },
        // D9 — ONE sofa, THREE AutoCount lines.
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
    const sb = seeded(true);
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
    const sb = seeded(true);
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'SO-2608-011' });
    const body = await wireBody(sb);
    const sent = new Set(Object.keys(body));
    expect(headerKeys(CS_CREATE_SO).filter((k) => !sent.has(k) && k !== 'Details')).toEqual([
      /* All four fall back to the invoice address, and DeliverContact /
         DeliverPhone1 to the debtor name and phone — AcSyncService.cs:169-176
         does the Or() itself, so omitting them is the intended shape. */
      'DeliverAddr1', 'DeliverAddr2', 'DeliverAddr3', 'DeliverAddr4',
      'DeliverContact', 'DeliverPhone1',
    ]);
  });
});

describe('/create-po — and the reason nothing reaches it', () => {
  test('D11: the header select names four columns scm.purchase_orders does not have', () => {
    const cols = schemaOf('purchase_orders');
    for (const phantom of ['creditor_code', 'creditor_name', 'agent', 'ref']) {
      expect(cols.has(phantom), `purchase_orders.${phantom} should not exist`).toBe(false);
    }
    // What it does have instead: the supplier is a foreign key, not a name.
    expect(cols.has('supplier_id')).toBe(true);
    expect(cols.has('notes')).toBe(true);
  });

  test('so a PO create queues NOTHING, and says nothing — the failure is swallowed', async () => {
    const sb = seeded();
    expect(await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-uuid-1' })).toBe(false);
    expect(sb.tables.autocount_outbox).toEqual([]);
  });

  test('a PO edit is dead for exactly the same reason', async () => {
    const sb = seeded();
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'PO', docId: 'po-uuid-1' })).toBe(false);
    expect(sb.tables.autocount_outbox).toEqual([]);
  });
});

describe('the four conversions', () => {
  const convert = async (op: any, docType: any, from: any, to: any, docNo: string) => {
    const sb = seeded();
    // The parent must already have an AutoCount counterpart, or the row waits.
    sb.tables[from.table][0].linked_ac_docno = 'AC-PARENT-1';
    expect(await enqueueConvert(sb as never, { companyId: 1, op, from, to, docType, docNo })).toBe(true);
    return wireBody(sb);
  };

  test('SO -> DO sends the parent document number and nothing else that matters', async () => {
    const body = await convert(
      'so_to_do', 'DO',
      { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
      { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
      'DO-2608-009',
    );
    expect(body).toEqual({
      FromDocNo: 'AC-PARENT-1',
      DocDate: null,   // D4
      Ref: null,       // D4
      // D5: no DocNo, so AutoCount numbers the delivery order itself.
      // No DtlKeys on purpose — AcSyncService.cs:300-329 asks the BOOK which
      // lines are still outstanding, which is the only authority on that.
    });
  });

  test('PO -> GRN carries no SupplierDONo, though the route reads one', async () => {
    const body = await convert(
      'po_to_gr', 'GR',
      { table: 'purchase_orders', keyCol: 'id', key: 'po-uuid-1' },
      { table: 'grns', keyCol: 'id', key: 'grn-uuid-1' },
      'GRN-2608-003',
    );
    expect(body).toEqual({ FromDocNo: 'AC-PARENT-1', DocDate: null, Ref: null });
    expect(headerKeys(CS_CONVERT)).toContain('SupplierDONo');
    expect(Object.keys(body)).not.toContain('SupplierDONo');
  });

  test('DO -> Invoice', async () => {
    const body = await convert(
      'do_to_iv', 'IV',
      { table: 'delivery_orders', keyCol: 'id', key: 'do-uuid-1' },
      { table: 'sales_invoices', keyCol: 'id', key: 'si-uuid-1' },
      'SI-2608-002',
    );
    expect(body).toEqual({ FromDocNo: 'AC-PARENT-1', DocDate: null, Ref: null });
  });

  test('GRN -> Purchase Invoice carries no SupplierInvoiceNo either', async () => {
    const body = await convert(
      'gr_to_pi', 'PI',
      { table: 'grns', keyCol: 'id', key: 'grn-uuid-1' },
      { table: 'purchase_invoices', keyCol: 'id', key: 'pi-uuid-1' },
      'PI-2608-002',
    );
    expect(body).toEqual({ FromDocNo: 'AC-PARENT-1', DocDate: null, Ref: null });
    expect(headerKeys(CS_CONVERT)).toContain('SupplierInvoiceNo');
    expect(Object.keys(body)).not.toContain('SupplierInvoiceNo');
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
  test('exactly the two fields Cancel reads, and a DocType it understands', async () => {
    const sb = seeded();
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    expect(await enqueueCancel(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'SO-2608-011',
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'SO-2608-011' },
    })).toBe(true);

    const body = await wireBody(sb);
    expect(body).toEqual({ DocType: 'SO', DocNo: 'AC-SO-9' });
    expect(Object.keys(body).sort()).toEqual(headerKeys(CS_CANCEL));
    /* The DocNo is AutoCount's, not the ERP's — resolved at drain from
       linked_ac_docno. Sending the ERP number would cancel nothing, or worse. */
    expect(body.DocNo).not.toBe('SO-2608-011');
  });

  test('every doc type the ERP can queue is a case the C# switch handles', () => {
    for (const t of ['SO', 'PO', 'DO', 'IV', 'GR', 'PI']) {
      expect(CS_CANCEL, `Cancel has no case for ${t}`).toContain(`case "${t}":`);
    }
  });
});

describe('/edit', () => {
  test('the envelope, the header, and a line addressed by its AutoCount DtlKey', async () => {
    /* With PR #1819 landed. Without it the line select 42703s and the edit goes
       over with NO Lines at all — the same D13 the create path has, asserted at
       the end of this block. */
    const sb = seeded(true);
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
    // Every header key must be one the C# allow-list will actually apply.
    const allow = new Set(csEditHeaderAllowList());
    expect(Object.keys(body.Header as object).filter((k) => !allow.has(k))).toEqual([]);

    const lines = body.Lines as Record<string, unknown>[];
    expect(lines).toHaveLength(5);
    /* A line the ERP knows the AutoCount DtlKey for is an UPDATE of that line
       (AcSyncService.cs:395-397); one without is an APPEND (:398-401). */
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
    // Every line key must be one the edit loop reads.
    const lineRead = new Set(detailKeys(CS_EDIT));
    for (const l of lines) expect(Object.keys(l).filter((k) => !lineRead.has(k))).toEqual([]);
    /* D6 — ItemCode rides along on line 0 and AcSyncService will not apply it,
       because it only sets ItemCode on the APPEND branch. A tbc-swap therefore
       changes Desc2 and the price in AutoCount and leaves the old product. */
    expect(CS_EDIT.indexOf('d.ItemCode')).toBeGreaterThan(CS_EDIT.indexOf('d = doc.AddDetail();'));
    expect(CS_EDIT.indexOf('d.ItemCode')).toBeLessThan(CS_EDIT.indexOf('it.ContainsKey("Description")'));
  });

  test('D13 again: without PR #1819 the edit carries no lines either', async () => {
    const sb = seeded(false);
    sb.tables.mfg_sales_orders[0].linked_ac_docno = 'AC-SO-9';
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'SO-2608-011' })).toBe(true);
    expect((await wireBody(sb)).Lines).toEqual([]);
  });

  test('D8: the fields /edit would apply and the ERP never sends', () => {
    const allow = csEditHeaderAllowList();
    for (const f of ['Agent', 'SalesLocation', 'Description', 'Remark2']) {
      expect(allow, `the C# allow-list is missing ${f}`).toContain(f);
    }
  });

  test('linked_ac_dtlkey is NOT in the schema yet, so today every line reads as new', () => {
    expect(schemaOf('mfg_sales_order_items').has('linked_ac_dtlkey')).toBe(false);
    expect(schemaOf('purchase_order_items').has('linked_ac_dtlkey')).toBe(false);
  });
});

// ── the register itself ─────────────────────────────────────────────────────

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
    /* If this fails you have either found a thirteenth or fixed one of the
       twelve. Both are good news; update the list and section 11 of
       docs/modules/autocount-writeback.md together. */
    expect(DIVERGENCES).toHaveLength(13);
    expect(DIVERGENCES.filter((d) => d.severity === 'critical').map((d) => d.id))
      .toEqual(['D9', 'D10', 'D11', 'D13']);
  });
});

// ── the trial harness posts the same contract ───────────────────────────────

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

// ── the mutation proof, run over every field of every payload ───────────────

describe('mutation proof — each field is load-bearing', () => {
  /** Every leaf path of an object, as a list of keys/indices. */
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
    const sb = seeded(true);
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

    const sb2 = seeded(true);
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
    /* The extraction is the anti-drift mechanism, so prove IT is load-bearing:
       a service that stopped reading DebtorCode would no longer be matched. */
    const renamed = acSyncSource.replace('Str(p, "DebtorCode")', 'Str(p, "AccountCode")');
    const keys = [...renamed.slice(
      renamed.indexOf('static string CreateSo('),
      renamed.indexOf('static string CreatePo('),
    ).matchAll(/(?:Str|Dec|Date|Dict|List)\(\s*p\s*,\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    expect(keys).toContain('AccountCode');
    expect(keys).not.toContain('DebtorCode');
  });
});
