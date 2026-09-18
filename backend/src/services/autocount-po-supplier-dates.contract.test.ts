// A purchase order's supplier delivery dates on their way into the account book
// (owner 2026-09-15, option A; docs/bugs/0918). The dates go as the book's PO
// UDFs EDate / EDate2 / EDate3, and a BLANK slot must be ABSENT from the payload:
// AcSyncService turns a present null into "" and blanks the book's own date.
import { describe, expect, test } from 'vitest';
import rawAcSync from '../../scripts/autocount-service/AcSyncService.cs?raw';
import rawOutbox from '../scm/lib/autocount-outbox.ts?raw';
import {
  composeCreatePo,
  composeSoToPo,
  composeEdit,
  type ErpPoHeader,
  type ErpLine,
} from './autocount-writeback';
import { buildAcItemIndex } from './autocount-item-code';
import { poSupplierDateUdf, poEditHeader } from './autocount-po-supplier-dates';

const acSync = rawAcSync.replace(/\r\n/g, '\n');
const outbox = rawOutbox.replace(/\r\n/g, '\n');

const TEST_INDEX = buildAcItemIndex('AC-CODE-1\tSKU-1\tMATTRESS\t400-H004');
const line = (over: Partial<ErpLine> = {}): ErpLine => ({
  item_code: 'SKU-1', description: 'Mattress', qty: 1, unit_price_sen: 10_000, location: 'KL', ...over,
});
const po = (over: Partial<ErpPoHeader> = {}): ErpPoHeader => ({
  po_number: 'HC-PO-1', po_date: '2026-09-01', creditor_code: '400-H004',
  creditor_name: 'Supplier Sdn Bhd', agent: null, ref: null, source_so_no: null, notes: 'N',
  purchase_location: 'KL', linked_ac_docno: 'PO-009950',
  supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  ...over,
});

describe('poSupplierDateUdf — slot 2/3/4 -> EDate/EDate2/EDate3', () => {
  test('every slot set maps one-to-one, in the book spelling', () => {
    expect(poSupplierDateUdf({
      supplier_delivery_date_2: '2026-09-12',
      supplier_delivery_date_3: '2026-09-19',
      supplier_delivery_date_4: '2026-09-26',
    })).toEqual({ EDate: '2026-09-12', EDate2: '2026-09-19', EDate3: '2026-09-26' });
  });

  test('a NULL slot is ABSENT, not null and not ""', () => {
    const udf = poSupplierDateUdf({ supplier_delivery_date_2: null, supplier_delivery_date_3: '2026-09-12', supplier_delivery_date_4: undefined });
    expect(udf).toEqual({ EDate2: '2026-09-12' });
    expect(Object.prototype.hasOwnProperty.call(udf, 'EDate')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(udf, 'EDate3')).toBe(false);
  });

  test('a timestamp is trimmed to the date, and a non-date is dropped rather than sent', () => {
    expect(poSupplierDateUdf({ supplier_delivery_date_2: '2026-09-12T00:00:00+00:00', supplier_delivery_date_3: 'soon' }))
      .toEqual({ EDate: '2026-09-12' });
  });
});

describe('/create-po and /so-to-po carry the dates in UDF', () => {
  test('the create master sends them, and a blank slot is not a key', () => {
    const body = composeCreatePo(po({ supplier_delivery_date_2: '2026-09-12', supplier_delivery_date_4: '2026-10-01' }), [line()], { itemIndex: TEST_INDEX });
    expect(body.UDF).toEqual({ EDate: '2026-09-12', EDate3: '2026-10-01' });
    expect('EDate2' in body.UDF).toBe(false);
  });

  test('no dates at all is still the empty UDF the book has always been sent', () => {
    expect(composeCreatePo(po(), [line()], { itemIndex: TEST_INDEX }).UDF).toEqual({});
  });

  test('the transfer spreads the master, so it carries the same UDF', () => {
    const m = composeCreatePo(po({ supplier_delivery_date_3: '2026-09-19' }), [line()], { itemIndex: TEST_INDEX });
    expect(composeSoToPo(m, [4242], m.Details).UDF).toEqual({ EDate2: '2026-09-19' });
  });
});

describe('/edit carries the dates in Header.UDF', () => {
  test('a date on the PO becomes Header.UDF on the wire body', () => {
    const body = composeEdit('PO', 'PO-009950', poEditHeader(po({ supplier_delivery_date_3: '2026-09-12' })),
      [line({ linked_ac_dtlkey: 4242 } as Partial<ErpLine>)], { itemIndex: TEST_INDEX, supplierCode: '400-H004' });
    expect(body.Header).toEqual({ CreditorName: 'Supplier Sdn Bhd', Description: 'N', UDF: { EDate2: '2026-09-12' } });
  });

  test('a PO with every slot blank sends NO UDF key at all, so the book keeps its own dates', () => {
    const header = poEditHeader(po());
    expect(header).toEqual({ CreditorName: 'Supplier Sdn Bhd', Description: 'N' });
    expect('UDF' in header).toBe(false);
  });

  test('a PO with one slot cleared omits THAT key and still sends the others', () => {
    const header = poEditHeader(po({ supplier_delivery_date_2: null, supplier_delivery_date_3: '2026-09-19' }));
    expect(header.UDF).toEqual({ EDate2: '2026-09-19' });
    expect(Object.values(header.UDF as Record<string, string>)).not.toContain(null);
    expect(Object.values(header.UDF as Record<string, string>)).not.toContain('');
  });
});

describe('the other half: what the ERP reads and what AcSyncService applies', () => {
  test('readPoHeader selects the three slots, and the PO edit uses poEditHeader', () => {
    const cols = /const PO_HEADER_COLS =\s*'([^']+)'/.exec(outbox)?.[1] ?? '';
    for (const c of ['supplier_delivery_date_2', 'supplier_delivery_date_3', 'supplier_delivery_date_4']) {
      expect(cols, `PO_HEADER_COLS is missing ${c}`).toContain(c);
    }
    expect(outbox).toMatch(/composeEdit\('PO',[^\n]*poEditHeader\(header\)/);
  });

  test('every PO route applies UDF from the payload it is given', () => {
    /* CreatePo reads p.UDF; /so-to-po and the conversions go through
       PurchaseHeader, which reads p.UDF; /edit reads Header.UDF. ApplyUdf is
       what reads the nested object. No service change is needed for the keys. */
    const createPo = acSync.slice(acSync.indexOf('static string CreatePo('), acSync.indexOf('// ── conversions'));
    expect(createPo).toContain('ApplyUdf(p, k => po.UDF[k], (k, v) => po.UDF[k] = v);');
    const purchaseHeader = acSync.slice(acSync.indexOf('static void PurchaseHeader('), acSync.indexOf('/* Source line keys'));
    expect(purchaseHeader).toContain('ApplyUdf(p, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);');
    const edit = acSync.slice(acSync.indexOf('Edit(Dictionary<string, object> p)'), acSync.indexOf('// ── helpers'));
    expect(edit).toContain('var h = Dict(p, "Header");');
    expect(edit).toContain('ApplyUdf(h, k => doc.UDF[k], (k, v) => doc.UDF[k] = v);');
    const applyUdf = acSync.slice(acSync.indexOf('static void ApplyUdf('), acSync.indexOf('static void SetUdf('));
    expect(applyUdf).toContain('var udf = Dict(p, "UDF");');
  });

  test('a date UDF is tried as a DateTime when the book refuses the string', () => {
    /* The book's UDF_EDate* columns are datetime, like SO.UDF_PDate, which lands
       this way today. */
    const setUdf = acSync.slice(acSync.indexOf('static void SetUdf('), acSync.indexOf('NOT APPLIED', acSync.indexOf('static void SetUdf(')));
    expect(setUdf).toContain('shapes.Add("DateTime"); values.Add(dt);');
  });
});
