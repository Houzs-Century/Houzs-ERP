/* A voucher's words (owner 2026-11-06: 有时我要改 description): the notes and the
   lines' descriptions may change until the voucher is approved, a checked one
   included. They move no money, so nothing else may move with them: no amount,
   account or payee, no stage mark, and the trail says what changed. Once approved,
   the journal carries the lines' words, so they stay. Real handler, fake PostgREST. */

import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { updatePaymentVoucherTextHandler } from '../src/scm/routes/payment-vouchers-text';

const CO = 1;
const CHECKED: Row = {
  id: 'pv-1', pv_number: 'HC-HPV-2610-139', company_id: CO, status: 'DRAFT', voucher_date: '2026-10-06',
  payee_name: 'KL CHEN ENTERPRISE (M) SDN BHD', supplier_id: 'sup-1', credit_account_code: '310-0020',
  currency: 'MYR', exchange_rate: 1, purpose: 'SUPPLIER_PAYMENT', total_sen: 2_000_000, bank_charge_sen: 0,
  notes: 'BILL PI-000555 · DATED 2026-09-21', bill_ref: 'PI-000555', bill_date: '2026-09-21',
  submitted_at: '2026-11-06T03:21:42Z', submitted_by: 'Siti Rafidah',
  checked_at: '2026-11-06T03:22:41Z', checked_by: 'Siti Rafidah',
  approved_at: null, approved_by: null, updated_at: '2026-11-06T03:22:41Z',
};
const LINES: Row[] = [
  { id: 'l-1', company_id: CO, pv_id: 'pv-1', line_no: 1, description: 'Rental deposit', debit_account_code: '900-R032', amount_sen: 1_500_000, project_id: 2261 },
  { id: 'l-2', company_id: CO, pv_id: 'pv-1', line_no: 2, description: 'Rental balance', debit_account_code: '900-R032', amount_sen: 500_000, project_id: 2261 },
  { id: 'l-9', company_id: CO, pv_id: 'pv-other', line_no: 1, description: 'Another voucher', debit_account_code: '900-A001', amount_sen: 100, project_id: null },
];

type Sb = ReturnType<typeof fakeSb>;
const worldWith = (over: Row = {}): Sb => fakeSb({
  payment_vouchers: [{ ...CHECKED, ...over }],
  payment_voucher_lines: LINES.map((l) => ({ ...l })),
  entity_audit_log: [],
});
const send = async (sb: Sb, body: unknown, opts: { perms?: string[]; companyId?: number } = {}) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, (opts.companyId ?? CO) as never);
    c.set('allowedCompanyIds' as never, [opts.companyId ?? CO] as never);
    c.set('houzsUser' as never, { id: 9, name: 'Carrie Ong', permissions_set: new Set(opts.perms ?? ['scm.payment_voucher.write']) } as never);
    await next();
  });
  app.patch('/pv/:id/text', updatePaymentVoucherTextHandler as never);
  const res = await app.request('/pv/pv-1/text', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: res.status, body: await res.json() as Record<string, any> };
};
const voucher = (sb: Sb) => sb.tables.payment_vouchers![0]!;
const line = (sb: Sb, id: string) => sb.tables.payment_voucher_lines!.find((l) => l.id === id)!;

let sb: Sb;
beforeEach(() => { sb = worldWith(); });

describe('a checked voucher\'s words', () => {
  test('the notes and a line\'s description change, and it stays checked', async () => {
    const r = await send(sb, { notes: '  Rental for Sunway Kluang, 5 to 11 Oct  ', lines: [{ id: 'l-2', description: ' Balance of the rental ' }] });
    expect(r.status).toBe(200);
    expect(voucher(sb).notes).toBe('Rental for Sunway Kluang, 5 to 11 Oct');
    expect(line(sb, 'l-2').description).toBe('Balance of the rental');
    expect(line(sb, 'l-1').description).toBe('Rental deposit');
    expect(voucher(sb).checked_by).toBe('Siti Rafidah');
    expect(voucher(sb).checked_at).toBe('2026-11-06T03:22:41Z');
    expect(voucher(sb).submitted_at).toBe('2026-11-06T03:21:42Z');
    expect(voucher(sb).status).toBe('DRAFT');
  });

  test('money, accounts, payee and the event cannot come along', async () => {
    const r = await send(sb, {
      notes: 'New words', payeeName: 'Someone Else', creditAccountCode: '310-0010', totalSen: 1, supplierId: 'sup-2', voucherDate: '2026-01-01',
      lines: [{ id: 'l-1', description: 'New line', amountSen: 1, debitAccountCode: '900-A001', projectId: 1 }],
    });
    expect(r.status).toBe(200);
    expect(voucher(sb)).toMatchObject({
      payee_name: 'KL CHEN ENTERPRISE (M) SDN BHD', credit_account_code: '310-0020', total_sen: 2_000_000, supplier_id: 'sup-1', voucher_date: '2026-10-06',
    });
    expect(line(sb, 'l-1')).toMatchObject({ description: 'New line', amount_sen: 1_500_000, debit_account_code: '900-R032', project_id: 2261 });
  });

  test('blank notes and a blank description clear them', async () => {
    const r = await send(sb, { notes: '   ', lines: [{ id: 'l-1', description: '' }] });
    expect(r.status).toBe(200);
    expect(voucher(sb).notes).toBeNull();
    expect(line(sb, 'l-1').description).toBeNull();
  });

  test('only the lines named change; notes left out stay', async () => {
    const r = await send(sb, { lines: [{ id: 'l-1', description: 'Deposit for the booth' }] });
    expect(r.status).toBe(200);
    expect(voucher(sb).notes).toBe('BILL PI-000555 · DATED 2026-09-21');
    expect(line(sb, 'l-1').description).toBe('Deposit for the booth');
    expect(line(sb, 'l-2').description).toBe('Rental balance');
  });

  test('the trail says who changed which words, from what to what', async () => {
    await send(sb, { notes: 'New words', lines: [{ id: 'l-2', description: 'New line' }] });
    const trail = sb.tables.entity_audit_log!;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ entity_type: 'PAYMENT_VOUCHER', entity_id: 'pv-1', entity_doc_no: 'HC-HPV-2610-139', action: 'UPDATE' });
    expect(trail[0]!.actor_name_snapshot).toBe('Carrie Ong');
    expect(trail[0]!.field_changes).toEqual([
      { field: 'notes', from: 'BILL PI-000555 · DATED 2026-09-21', to: 'New words' },
      { field: 'lineDescription', from: 'Rental balance', to: 'New line' },
    ]);
  });

  test('nothing different: nothing written, no trail', async () => {
    const r = await send(sb, { notes: 'BILL PI-000555 · DATED 2026-09-21', lines: [{ id: 'l-1', description: 'Rental deposit' }] });
    expect(r.status).toBe(200);
    expect(voucher(sb).updated_at).toBe('2026-11-06T03:22:41Z');
    expect(sb.tables.entity_audit_log).toHaveLength(0);
  });
});

/* The bank it pays into (owner 2026-11-09: 可以，开放): 31 checked vouchers had no
   bank anywhere, so the three fields come through the same door until approval.
   Like the words, they move no money and stay on the trail. */
describe('a checked voucher\'s bank', () => {
  test('filled in, trimmed, and it stays checked', async () => {
    const r = await send(sb, { payToBankName: ' MAYBANK ', payToAccountNo: '5123 4567 8901', payToAccountName: 'KL CHEN ENTERPRISE (M) SDN BHD' });
    expect(r.status).toBe(200);
    expect(voucher(sb)).toMatchObject({
      pay_to_bank_name: 'MAYBANK', pay_to_account_no: '5123 4567 8901', pay_to_account_name: 'KL CHEN ENTERPRISE (M) SDN BHD',
      checked_by: 'Siti Rafidah', checked_at: '2026-11-06T03:22:41Z', status: 'DRAFT', notes: 'BILL PI-000555 · DATED 2026-09-21',
    });
    expect(r.body.paymentVoucher.pay_to_bank_name).toBe('MAYBANK');
  });

  test('the trail names each field, from what to what', async () => {
    sb = worldWith({ pay_to_bank_name: 'CIMB', pay_to_account_no: '8000 1111', pay_to_account_name: 'KL CHEN ENTERPRISE (M) SDN BHD' });
    await send(sb, { notes: 'New words', payToBankName: 'MAYBANK', payToAccountNo: '5123 4567 8901', payToAccountName: 'KL CHEN ENTERPRISE (M) SDN BHD' });
    const trail = sb.tables.entity_audit_log!;
    expect(trail).toHaveLength(1);
    expect(trail[0]!.field_changes).toEqual([
      { field: 'notes', from: 'BILL PI-000555 · DATED 2026-09-21', to: 'New words' },
      { field: 'payToBankName', from: 'CIMB', to: 'MAYBANK' },
      { field: 'payToAccountNo', from: '8000 1111', to: '5123 4567 8901' },
    ]);
  });

  test('fields left out stay; a blank one is cleared', async () => {
    sb = worldWith({ pay_to_bank_name: 'CIMB', pay_to_account_no: '8000 1111', pay_to_account_name: 'KL CHEN' });
    const r = await send(sb, { payToAccountName: '   ' });
    expect(r.status).toBe(200);
    expect(voucher(sb)).toMatchObject({ pay_to_bank_name: 'CIMB', pay_to_account_no: '8000 1111', pay_to_account_name: null });
  });

  test('the same bank again: nothing written, no trail', async () => {
    sb = worldWith({ pay_to_bank_name: 'CIMB', pay_to_account_no: '8000 1111', pay_to_account_name: null });
    const r = await send(sb, { payToBankName: 'CIMB', payToAccountNo: '8000 1111', payToAccountName: '' });
    expect(r.status).toBe(200);
    expect(voucher(sb).updated_at).toBe('2026-11-06T03:22:41Z');
    expect(sb.tables.entity_audit_log).toHaveLength(0);
  });

  test('approved: refused, the bank stays', async () => {
    sb = worldWith({ approved_at: '2026-11-06T04:00:00Z', approved_by: 'Owner' });
    const r = await send(sb, { payToBankName: 'MAYBANK', payToAccountNo: '5123' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('already_approved');
    expect(voucher(sb).pay_to_bank_name ?? null).toBeNull();
    expect(sb.tables.entity_audit_log).toHaveLength(0);
  });
});

describe('who and when', () => {
  test.each([
    ['a draft', { submitted_at: null, submitted_by: null, checked_at: null, checked_by: null }],
    ['a prepared voucher', { checked_at: null, checked_by: null }],
  ])('%s takes the same door', async (_name, over) => {
    sb = worldWith(over);
    expect((await send(sb, { notes: 'New words' })).status).toBe(200);
    expect(voucher(sb).notes).toBe('New words');
  });

  test.each([
    ['approved, its post unfinished', { approved_at: '2026-11-06T04:00:00Z', approved_by: 'Owner' }, 'already_approved'],
    ['posted', { status: 'POSTED', approved_at: '2026-11-06T04:00:00Z', approved_by: 'Owner' }, 'already_posted'],
    ['cancelled', { status: 'CANCELLED' }, 'cancelled'],
  ])('%s: refused, nothing changes', async (_name, over, error) => {
    sb = worldWith(over);
    const r = await send(sb, { notes: 'New words', lines: [{ id: 'l-1', description: 'New line' }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(error);
    expect(voucher(sb).notes).toBe('BILL PI-000555 · DATED 2026-09-21');
    expect(line(sb, 'l-1').description).toBe('Rental deposit');
    expect(sb.tables.entity_audit_log).toHaveLength(0);
  });

  test('without the write key: refused', async () => {
    const r = await send(sb, { notes: 'New words' }, { perms: ['scm.payment_voucher.check'] });
    expect(r.status).toBe(403);
    expect(voucher(sb).notes).toBe('BILL PI-000555 · DATED 2026-09-21');
  });

  test('another company\'s voucher is not found', async () => {
    const r = await send(sb, { notes: 'New words' }, { companyId: 2 });
    expect(r.status).toBe(404);
    expect(voucher(sb).notes).toBe('BILL PI-000555 · DATED 2026-09-21');
  });

  test('a line of another voucher: refused before anything is written', async () => {
    const r = await send(sb, { notes: 'New words', lines: [{ id: 'l-1', description: 'New line' }, { id: 'l-9', description: 'Not this voucher' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('line_not_on_voucher');
    expect(voucher(sb).notes).toBe('BILL PI-000555 · DATED 2026-09-21');
    expect(line(sb, 'l-1').description).toBe('Rental deposit');
    expect(line(sb, 'l-9').description).toBe('Another voucher');
  });

  test('when the trail cannot be written, nothing is', async () => {
    sb.rpcHandlers.entity_audit_writable = () => false;
    const r = await send(sb, { notes: 'New words' });
    expect(r.status).toBe(409);
    expect(voucher(sb).notes).toBe('BILL PI-000555 · DATED 2026-09-21');
  });
});
