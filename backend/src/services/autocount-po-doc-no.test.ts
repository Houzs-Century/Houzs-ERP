// The order's reference goes to AutoCount's Ref, never to its "PO Doc No.", and
// a purchase order names the sales orders it was made from the way the office
// plug-in does (docs/bugs/0926).
//
// Measured on the live book on 2026-09-15:
//   - ERP edits changed "UDF PO Doc No." from a PO number to the reference on 92
//     orders and from blank to the reference on 376;
//   - plug-in purchase orders carry the order's number in UDF_SONo on 908 of 910
//     pairs, and the order's reference in Ref on 897.
import { describe, expect, test } from 'vitest';
import {
  clearedAcKeys,
  composeCreatePo,
  composeCreateSo,
  soReference,
  type ComposeOptions,
  type ErpLine,
  type ErpPoHeader,
  type ErpSoHeader,
} from './autocount-writeback';
import { buildAcItemIndex } from './autocount-item-code';
import { poEditHeader } from './autocount-po-supplier-dates';
import { soEditHeader } from '../scm/lib/so-edit-header';
import { readPoSourceSo } from '../scm/lib/autocount-po-source-so';
import { fakeSb } from '../scm/lib/fake-postgrest';

const opts: ComposeOptions = { itemIndex: buildAcItemIndex('AC-CODE-1\tSKU-1\tMATTRESS\t400-H004') };
const line = (over: Partial<ErpLine> = {}): ErpLine => ({
  item_code: 'SKU-1', description: 'Mattress', qty: 1, unit_price_sen: 100_000, location: 'KL', ...over,
});
const so = (over: Partial<ErpSoHeader> = {}): ErpSoHeader => ({
  doc_no: 'HC-SO-2609-074', so_date: '2026-09-14', debtor_name: 'Customer', agent: 'kar jiun',
  sales_location: 'KL', branding: null, venue: null, address1: null, address2: null, address3: null,
  address4: null, city: null, postcode: null, customer_state: null, phone: null, emergency_contact_phone: null,
  ref: null, customer_so_no: 'MR TAN / SUNWAY', ...over,
});
const po = (over: Partial<ErpPoHeader> = {}): ErpPoHeader => ({
  po_number: 'HC-PO-2609-122', po_date: '2026-09-14', creditor_code: '400-H004', creditor_name: 'Supplier',
  agent: null, ref: null, source_so_no: null, notes: null, purchase_location: 'KL', ...over,
});

const asSb = (sb: unknown) => sb as Parameters<typeof readPoSourceSo>[0];

describe('a sales order: the reference is Ref, and the PO Doc No. is left to purchase orders', () => {
  test('a create sends the typed reference as Ref and nothing in ToPONo', () => {
    const body = composeCreateSo(so(), [line()], null, null, [], opts);
    expect(body.Ref).toBe('MR TAN / SUNWAY');
    expect(body.UDF).not.toHaveProperty('ToPONo');
  });

  test('an order whose reference sits only in ref still sends it as Ref', () => {
    const body = composeCreateSo(so({ customer_so_no: null, ref: 'PG10 / IOI' }), [line()], null, null, [], opts);
    expect(body.Ref).toBe('PG10 / IOI');
  });

  test('an edit sends the reference as Ref and never touches ToPONo', () => {
    const h = soEditHeader({ ...so(), linked_ac_docno: 'HC-SO-2609-074' }, null, [line()], null, [], []);
    expect(h.Ref).toBe('MR TAN / SUNWAY');
    expect((h.UDF ?? {}) as Record<string, string>).not.toHaveProperty('ToPONo');
  });

  test('ref wins over customer_so_no, and clearing one clears Ref only when the other is empty too', () => {
    expect(soReference({ customer_so_no: 'CSO', ref: 'PG10 / IOI' })).toBe('PG10 / IOI');
    expect(soReference({ customer_so_no: 'CSO', ref: '  ' })).toBe('CSO');
    expect(clearedAcKeys(['customer_so_no'], { customer_so_no: '', ref: null }).header).toEqual(['Ref']);
    expect(clearedAcKeys(['customer_so_no'], { customer_so_no: '', ref: 'PG10 / IOI' }).header).toEqual([]);
  });
});

describe('a purchase order names its source sales order the way the plug-in does', () => {
  const world = (poLines: Array<{ so_item_id: string | null }>, orders: Array<Record<string, unknown>>, soItems: Array<Record<string, unknown>>) => fakeSb({
    purchase_order_items: poLines.map((l, i) => ({ id: `pl-${i}`, purchase_order_id: 'po-1', ...l })),
    mfg_sales_order_items: soItems,
    mfg_sales_orders: orders,
  });

  test('one source order: Ref is its reference and UDF_SONo its book number', async () => {
    const sb = world([{ so_item_id: 'si-1' }, { so_item_id: 'si-2' }],
      [{ doc_no: 'HC-SO-012411', ref: 'MR LIM / PAVILION', customer_so_no: 'MR LIM / PAVILION', linked_ac_docno: 'SO-012411' }],
      [{ id: 'si-1', doc_no: 'HC-SO-012411' }, { id: 'si-2', doc_no: 'HC-SO-012411' }]);
    const src = await readPoSourceSo(asSb(sb), 'po-1');
    expect(src).toEqual({ ref: 'MR LIM / PAVILION', source_so_no: 'SO-012411' });

    const body = composeCreatePo(po(src), [line()], opts);
    expect(body.Ref).toBe('MR LIM / PAVILION');
    expect(body.UDF).toEqual({ SONo: 'SO-012411' });
    expect(poEditHeader(po(src))).toMatchObject({ Ref: 'MR LIM / PAVILION', UDF: { SONo: 'SO-012411' } });
  });

  test('several source orders: UDF_SONo names them all in the plug-in form, and Ref is left to the book', async () => {
    const sb = world([{ so_item_id: 'si-1' }, { so_item_id: 'si-2' }, { so_item_id: null }],
      [
        { doc_no: 'HC-SO-2609-074', ref: null, customer_so_no: 'A', linked_ac_docno: 'HC-SO-2609-074' },
        { doc_no: 'HC-SO-012411', ref: 'B', customer_so_no: 'B', linked_ac_docno: 'SO-012411' },
      ],
      [{ id: 'si-1', doc_no: 'HC-SO-2609-074' }, { id: 'si-2', doc_no: 'HC-SO-012411' }]);
    const src = await readPoSourceSo(asSb(sb), 'po-1');
    expect(src).toEqual({ ref: null, source_so_no: 'HC-SO-2609-074, SO-012411' });

    const body = composeCreatePo(po(src), [line()], opts);
    expect(body.Ref, 'our own SO numbers are not a reference').toBeNull();
    expect(body.UDF).toEqual({ SONo: 'HC-SO-2609-074, SO-012411' });
    expect(poEditHeader(po(src))).not.toHaveProperty('Ref');
  });

  test('a purchase for stock names no order at all, so the book keeps both fields', async () => {
    const sb = world([{ so_item_id: null }], [], []);
    const src = await readPoSourceSo(asSb(sb), 'po-1');
    expect(src).toEqual({ ref: null, source_so_no: null });
    expect(composeCreatePo(po(src), [line()], opts).UDF).toEqual({});
    expect(poEditHeader(po(src))).toEqual({ CreditorName: 'Supplier' });
  });
});
