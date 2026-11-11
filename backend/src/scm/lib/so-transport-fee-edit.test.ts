import { describe, expect, it } from 'vitest';
import { soTransportFeeEditProblem } from './so-transport-fee-edit';

/* The transport-fee rule on an edit of a live Houzs order (owner 2026-11-11):
   the route hands over the one change it is about to write. */
type Row = Record<string, unknown> & { _table: string };
const makeSb = (rows: Row[], broken: string[] = []) => ({
  from(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const err = broken.includes(table) ? { message: `connection reset (${table})` } : null;
    const run = () => rows.filter((r) => r._table === table).filter((r) => eqs.every(([c, v]) => r[c] === v));
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
      maybeSingle: async () => (err ? { data: null, error: err } : { data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve(err ? { data: null, error: err } : { data: run(), error: null }),
    };
    return b;
  },
});

const DOC = 'HC-SO-2611-001';
const order = (state: string, status = 'CONFIRMED'): Row => ({
  _table: 'mfg_sales_orders', doc_no: DOC, company_id: 1, status, customer_state: state, customer_country: 'Malaysia',
});
const line = (id: string, code: string, totalSen: number, group = 'service'): Row => ({
  _table: 'mfg_sales_order_items', doc_no: DOC, id, item_code: code, item_group: group, description: code,
  qty: 1, unit_price_sen: totalSen, discount_sen: 0, total_sen: totalSen, cancelled: false,
});
const goods = line('g1', 'Y103-(Q)', 150000, 'bedframe');
const fee = line('f1', 'TRANSPORTATION CHARGES', 8000);
type Change = Parameters<typeof soTransportFeeEditProblem>[1]['change'];
const ask = (rows: Row[], change: Change, companyCode = 'HOUZS', broken: string[] = []) =>
  soTransportFeeEditProblem(makeSb(rows, broken), { docNo: DOC, companyId: 1, companyCode, change });
const toSabah: Change = { kind: 'header', state: 'Sabah', country: 'Malaysia' };

describe('soTransportFeeEditProblem', () => {
  it('a State moved to Sabah with no fee is refused', async () => {
    expect((await ask([order('Selangor'), goods], toSabah))?.code).toBe('transport_fee_required');
  });
  it('a State moved to Sabah with a priced fee passes', async () => {
    expect(await ask([order('Selangor'), goods, fee], toSabah)).toBeNull();
  });
  it('deleting the fee line of a Sabah order is refused', async () => {
    expect(await ask([order('Sabah'), goods, fee], { kind: 'line', itemId: 'f1', after: null })).not.toBeNull();
  });
  it('re-pricing the fee to RM 0 is refused; to RM 50 passes', async () => {
    const at = (amountSen: number): Change => ({ kind: 'line', itemId: 'f1', after: { itemCode: 'TRANSPORTATION CHARGES', description: null, itemGroup: 'service', amountSen } });
    expect(await ask([order('Sabah'), goods, fee], at(0))).not.toBeNull();
    expect(await ask([order('Sabah'), goods, fee], at(5000))).toBeNull();
  });
  it('deleting a goods line of an older fee-less Sabah order is not refused', async () => {
    expect(await ask([order('Sabah'), goods, line('g2', 'PILLOW', 5000, 'accessory')], { kind: 'line', itemId: 'g2', after: null })).toBeNull();
  });
  it('a DRAFT is never judged here, nor a 2990 order', async () => {
    expect(await ask([order('Selangor', 'DRAFT'), goods], toSabah)).toBeNull();
    expect(await ask([order('Selangor'), goods], toSabah, '2990')).toBeNull();
  });
  it('an amendment that removes the fee, or moves to Sabah without one, is refused', async () => {
    expect(await ask([order('Sabah'), goods, fee], { kind: 'amendment', state: null, lines: [{ op: 'REMOVE', itemId: 'f1', itemCode: null, qty: null, unitPriceSen: null }] })).not.toBeNull();
    expect(await ask([order('Selangor'), goods], { kind: 'amendment', state: { state: 'Sabah', country: 'Malaysia' }, lines: [] })).not.toBeNull();
  });
  it('an amendment that moves to Sabah and adds a priced fee passes', async () => {
    expect(await ask([order('Selangor'), goods], {
      kind: 'amendment', state: { state: 'Sabah', country: 'Malaysia' },
      lines: [{ op: 'ADD', itemId: null, itemCode: 'TRANSPORTATION CHARGES', qty: 1, unitPriceSen: 8000 }],
    })).toBeNull();
  });
  it('an unreadable lines read refuses rather than guessing', async () => {
    expect((await ask([order('Sabah'), goods, fee], { kind: 'line', itemId: 'f1', after: null }, 'HOUZS', ['mfg_sales_order_items']))?.code).toBe('transport_fee_check_failed');
  });
});
