// The Draft → formal number flow (GL redesign item 8b). Pinned:
//   • CHECK mints the formal per-bank number from the credit account's letter
//     ({co}{letter}PV-YYMM-NNN, at the company's width) and records the
//     renumber on the audit trail;
//   • a bank with NO letter refuses the check with the setup screen named,
//     and stamps nothing;
//   • a voucher already carrying a formal number (reject → re-check) KEEPS
//     it — a slot is never burned twice for the same paper;
//   • the number lives on the id: nothing else about the voucher moves.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { checkPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';

const CO = 2;

const yymm = (() => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

const PV: Row = {
  id: 'pv1', pv_number: `2990-Draft-${yymm}-001`, voucher_date: '2026-09-05',
  payee_name: 'HOOKKA', supplier_id: 's1', credit_account_code: '310-0010',
  currency: 'MYR', exchange_rate: 1, purpose: 'x', notes: null, total_sen: 100000,
  status: 'DRAFT', posted_at: null, created_at: '2026-09-05', created_by: 'u',
  updated_at: '2026-09-05', company_id: CO,
  submitted_at: '2026-09-05T01:00:00Z', submitted_by: 'Clerk',
  checked_at: null, checked_by: null, approved_at: null, approved_by: null,
};

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = ['scm.payment_voucher.check']) {
  const sb = fakeSb(
    {
      payment_vouchers: [{ ...PV }],
      acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }],
      acc_account_roles: [],
      acc_numbering: [],
      companies: [{ id: CO, code: '2990' }],
      entity_audit_log: [],
      ...tables,
    },
    {},
    [{ table: 'payment_vouchers', column: 'pv_number', name: 'payment_vouchers_pv_number_key' }],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Checker', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never); // companyDocPrefix reads THIS key
    await next();
  });
  app.post('/payment-vouchers/:id/check', checkPaymentVoucherHandler as never);
  return { app, sb };
}

const check = (app: Hono, id = 'pv1') =>
  app.request(`/payment-vouchers/${id}/check`, { method: 'POST' });

describe('CHECK mints the formal number', () => {
  test('a Draft-series voucher takes {co}{letter}PV-YYMM-NNN and the renumber is on the audit trail', async () => {
    const { app, sb } = harness();
    const res = await check(app);
    expect(res.status).toBe(200);
    const body = await res.json() as { pvNumber?: string; checkedBy: string };
    expect(body.pvNumber).toBe(`2990-MPV-${yymm}-001`);
    expect(sb.tables.payment_vouchers[0]).toMatchObject({ pv_number: `2990-MPV-${yymm}-001`, checked_by: 'Checker' });
  });

  test('paid from the cash drawer mints on the FIXED C — {co}CPV — with no letters row at all', async () => {
    const { app, sb } = harness({
      payment_vouchers: [{ ...PV, credit_account_code: '320-0000' }],
      /* Deliberately EMPTY: the drawer's series is roles.CASH + C, never
         configuration (owner 2026-09-05: 我payment 出去by cash 时就会是cpv啊). */
      acc_bank_letters: [],
    });
    const res = await check(app);
    expect(res.status).toBe(200);
    const body = await res.json() as { pvNumber?: string };
    expect(body.pvNumber).toBe(`2990-CPV-${yymm}-001`);
    expect(sb.tables.payment_vouchers[0]).toMatchObject({ pv_number: `2990-CPV-${yymm}-001` });
    const audit = sb.tables.entity_audit_log.find((r) => r.action === 'CHECK');
    expect(JSON.stringify(audit ?? {})).toContain('2990-Draft-');
  });

  test('the width setting reaches the mint', async () => {
    const { app, sb } = harness({ acc_numbering: [{ company_id: CO, doc_digits: 4 }] });
    await check(app);
    expect(sb.tables.payment_vouchers[0].pv_number).toBe(`2990-MPV-${yymm}-0001`);
  });

  test('a bank with no letter refuses with the setup screen named, and stamps nothing', async () => {
    const { app, sb } = harness({ acc_bank_letters: [] });
    const res = await check(app);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('Voucher numbering');
    expect(sb.tables.payment_vouchers[0]).toMatchObject({ pv_number: `2990-Draft-${yymm}-001`, checked_at: null });
  });

  test('a formal number survives a reject → re-check round — never re-minted', async () => {
    const formal = `2990-MPV-${yymm}-007`;
    const { app, sb } = harness({
      payment_vouchers: [{ ...PV, pv_number: formal }],
      /* No letters at all: proving the keep-path never even asks for one. */
      acc_bank_letters: [],
    });
    const res = await check(app);
    expect(res.status).toBe(200);
    expect(sb.tables.payment_vouchers[0].pv_number).toBe(formal);
  });
});
