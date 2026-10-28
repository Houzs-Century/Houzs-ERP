// A CUTOVER REPAIR MUST NOT QUEUE A WRITE-BACK — and a salesperson still must.
//
// The owner, 2026-09-09, on finding 173 sales orders waiting in the queue after
// two days of cutover repairs:
//
//   「正常来说你的这批更改不应该是syncback autocount啊 应该remain啊」
//   「你不可以有记录再这边啊 这是你import进来的错误 所以没有影响这些啊」
//
// A repair COPIES a value out of the account book. Sending it back is pointless
// where the two agree and destructive where they do not — it overwrites his
// single source of truth with our version of it. But the write-back itself is
// the point of the ERP being live: an order a salesperson creates or edits has
// to reach AutoCount. So the property under test is a PAIR, and neither half is
// worth having alone:
//
//   a script's client queues NOTHING;
//   a request's client queues exactly as before.
//
// WHY THE MARKER LIVES ON THE CLIENT AND NOT IN THE OPTIONS. Every enqueue*
// takes an options object, and an option is something each of ~40 repair
// scripts would have to remember. The transport is the thing a script cannot
// avoid: a script reaches the database through scripts/lib/pgrest-shim.mjs and
// a request reaches it through db/supabase.ts, and those are different objects.
// Marking the shim marks every script at once, including the ones not written
// yet.
//
// AND THE POLARITY IS DELIBERATE: suppressed is the DEFAULT for a script
// client, and a tool that genuinely means to push (rebuild-ac-document,
// requeue-autocount-skipped, the sync-ac-delta push lane) opts back IN. So a
// repair that forgets gets the SAFE behaviour, and the dangerous one is the one
// that has to be typed out and is therefore visible in review.
import { describe, expect, test, beforeEach } from 'vitest';
import {
  enqueueAcOp,
  enqueueSoCreate,
  enqueuePoCreate,
  enqueueCancel,
  enqueueEdit,
} from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { markRepairClient, isRepairClient } from './ac-repair-suppression';
import { fakeSb, type Row } from './fake-postgrest';

const SALESPERSON = { id: 'staff-1', name: 'Nurul Hidayah' };
const ERP_A = 'AKEMI APEX MATT (SP)';

const so = {
  doc_no: 'HC-SO-9', so_date: '2026-08-10', debtor_name: 'ACME', agent: 'KRIS',
  salesperson_id: 'staff-1',
  sales_location: 'KL WAREHOUSE', branding: 'AKEMI', venue: 'SUTERA MALL',
  address1: 'A1', address2: null, address3: null, address4: null,
  phone: '012', ref: 'R', linked_ac_docno: null,
};
const soItem = { doc_no: 'HC-SO-9', item_code: ERP_A, description: 'Mattress', qty: 2, unit_price_sen: 12345 };
const po = {
  id: 'po-1', po_number: 'HC-PO-9', po_date: '2026-08-10',
  supplier_id: 'sup-1', notes: 'a note', linked_ac_docno: null,
};
const supplier = { id: 'sup-1', code: '400-H004', name: 'Supplier' };

/** The write-back ON for company 1, which is the only state worth testing here:
 *  with it off, nothing queues for anybody and the test would pass vacuously. */
const onFor1 = (extra: Record<string, Row[]> = {}) =>
  fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
    autocount_outbox: [],
    staff: [{ ...SALESPERSON }],
    ...extra,
  });

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

beforeEach(() => resetWritebackFlagCache());

describe('a repair client queues nothing', () => {
  test('enqueueAcOp — the one insert every other path funnels through', async () => {
    const sb = markRepairClient(onFor1());
    expect(await enqueueAcOp(sb as never, {
      companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
    })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('enqueueSoCreate', async () => {
    const sb = markRepairClient(onFor1({
      mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }],
    }));
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('enqueuePoCreate', async () => {
    const sb = markRepairClient(onFor1({
      purchase_orders: [{ ...po }], purchase_order_items: [], suppliers: [{ ...supplier }],
    }));
    expect((await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-1' })).queued).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('enqueueEdit — the op the repairs actually produced', async () => {
    const sb = markRepairClient(onFor1({
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
      mfg_sales_order_items: [{ ...soItem, linked_ac_dtlkey: '55' }],
    }));
    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('enqueueCancel', async () => {
    const sb = markRepairClient(onFor1({
      mfg_sales_orders: [{ ...so, linked_ac_docno: 'SO-000021' }],
    }));
    expect(await enqueueCancel(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9',
      self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
    })).toBe(false);
    expect(outbox(sb)).toHaveLength(0);
  });

  test('it writes no `skipped` row either — a repair leaves NO trace in the queue', async () => {
    /* A skipped row is the ERP saying "I consciously will not send this", which
       is a statement about a document a person saved. A repair never asked the
       question, so answering it would put our import work in front of an
       operator as though it were business activity. The whole row is absent,
       not merely un-sent. */
    const sb = markRepairClient(onFor1({
      mfg_sales_orders: [], mfg_sales_order_items: [],
    }));
    await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-DOES-NOT-EXIST' });
    expect(outbox(sb)).toHaveLength(0);
  });
});

describe('a request client is untouched — the write-back keeps working', () => {
  test('enqueueSoCreate still queues for a salesperson', async () => {
    const sb = onFor1({ mfg_sales_orders: [{ ...so }], mfg_sales_order_items: [{ ...soItem }] });
    expect((await enqueueSoCreate(sb as never, { companyId: 1, docNo: 'HC-SO-9' })).queued).toBe(true);
    expect(outbox(sb)).toHaveLength(1);
    expect(outbox(sb)[0].op).toBe('create_so');
  });

  test('enqueueAcOp still queues', async () => {
    const sb = onFor1();
    expect(await enqueueAcOp(sb as never, {
      companyId: 1, op: 'create_so', docType: 'SO', docNo: 'HC-SO-1', payload: { body: {} },
    })).toBe(true);
    expect(outbox(sb)).toHaveLength(1);
  });
});

describe('the marker cannot arrive from a request', () => {
  test('a plain object — anything JSON could carry — is not a repair client', () => {
    expect(isRepairClient({})).toBe(false);
    expect(isRepairClient(null)).toBe(false);
    expect(isRepairClient(undefined)).toBe(false);
  });

  test('a body that spells the marker as a STRING key does not set it', () => {
    /* The marker is a symbol, and JSON has no symbols. This is the property
       that makes "impossible to set by accident from a UI request" structural
       rather than a convention: a request body, a query string and a header can
       only ever produce string keys. */
    const hostile = JSON.parse(JSON.stringify({
      'Symbol(houzs.ac.repairClient)': true,
      __repairClient: true,
      repairClient: true,
    }));
    expect(isRepairClient(hostile)).toBe(false);
  });

  test('the mark is not enumerable, so it does not survive a spread or JSON round-trip', () => {
    const sb = markRepairClient({ from: () => ({}) });
    expect(isRepairClient(sb)).toBe(true);
    expect(Object.keys(sb)).not.toContain('repairClient');
    expect(isRepairClient(JSON.parse(JSON.stringify(sb)))).toBe(false);
  });
});
