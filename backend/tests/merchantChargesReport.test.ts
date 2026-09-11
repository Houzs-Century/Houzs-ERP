/* The Merchant charges report (owner 2026-09-12, docs/bugs/0826). Pinned:
     • per month, per acquirer: lines, gross, merchant fee, net, fee % of gross;
     • the bank's own charge on a payout day sits beside the fee, by the day
       the payout landed, and the two together are the charge % of gross;
     • a total line per month across acquirers, and a grand total;
     • each month-and-acquirer carries the reports (files) behind it;
     • the confirmed-only and acquirer filters are the caller's; a bad range
       is refused; the permission gate answers at this end.
   Real handler, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { merchantChargesReport } from '../src/scm/routes/accounting-merchant-charges';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';
let rowId = 0;
const line = (batchId: number, acquirer: string, date: string, gross: number, fee: number, confirmed = true): Row => ({
  id: ++rowId, company_id: CO, batch_id: batchId, acquirer_code: acquirer, txn_date: date,
  gross_sen: gross, fee_sen: fee, net_sen: gross - fee, bucket: 'MATCHED', confirmed_at: confirmed ? `${date}T10:00:00Z` : null,
});

const world = () => fakeSb({
  acc_settlement_batches: [
    { id: 9, company_id: CO, acquirer_code: 'PBB', file_name: '2990HOMESB_CSV_20260606.csv', period_from: '2026-06-05', period_to: '2026-06-06' },
    { id: 10, company_id: CO, acquirer_code: 'PBB', file_name: '2990HOMESB_CSV_20260620.csv', period_from: '2026-06-20', period_to: '2026-06-20' },
    { id: 11, company_id: CO, acquirer_code: 'GHL', file_name: 'StatementOfAccountDetails2026-06-29.csv', period_from: '2026-06-02', period_to: '2026-06-28' },
    { id: 12, company_id: CO, acquirer_code: 'PBB', file_name: '2990HOMESB_CSV_20260712.csv', period_from: '2026-07-12', period_to: '2026-07-12' },
  ],
  acc_settlement_rows: [
    line(9, 'PBB', '2026-06-05', 100000, 800),
    line(10, 'PBB', '2026-06-20', 200000, 1600),
    line(11, 'GHL', '2026-06-14', 50000, 2000),
    line(12, 'PBB', '2026-07-12', 100000, 1790, false),   // uploaded, not yet confirmed
    line(12, 'PBB', '2026-08-01', 999900, 1, true),        // outside the range
  ],
  acc_settlement_payout_batches: [
    { id: 1, company_id: CO, payout_id: 1, batch_id: 9, settled_on: '2026-06-06', net_sen: 302418, charge_sen: 32400, charge_account_code: '900-T003' },
    { id: 2, company_id: CO, payout_id: 2, batch_id: 10, settled_on: '2026-06-21', net_sen: 198400, charge_sen: 0, charge_account_code: null },
  ],
});

function harness(perms: readonly string[] = [GL_PERM]) {
  const sb = world();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/reports/merchant-charges', merchantChargesReport as never);
  return { app, sb };
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/reports/merchant-charges?${qs}`);
  return { status: res.status, body: await res.json() as any };
};

describe('the Merchant charges report', () => {
  test('per month and per acquirer: gross, fee, net, fee %, with the bank charge beside it', async () => {
    const { app } = harness();
    const { status, body } = await read(app, 'from=2026-06&to=2026-07');
    expect(status).toBe(200);
    expect(body.months.map((m: any) => m.month)).toEqual(['2026-06', '2026-07']);
    const june = body.months[0];
    expect(june.acquirers.map((a: any) => a.acquirer)).toEqual(['GHL', 'PBB']);
    const pbb = june.acquirers[1];
    expect(pbb).toMatchObject({ lines: 2, grossSen: 300000, feeSen: 2400, netSen: 297600, feePct: 0.8, bankChargeSen: 32400, chargeSen: 34800, chargePct: 11.6 });
    expect(pbb.reports.map((r: any) => r.fileName)).toEqual(['2990HOMESB_CSV_20260606.csv', '2990HOMESB_CSV_20260620.csv']);
    expect(pbb.reports[0]).toMatchObject({ batchId: 9, lines: 1, grossSen: 100000, feeSen: 800, feePct: 0.8, bankChargeSen: 32400, chargePct: 33.2 });
    expect(june.acquirers[0]).toMatchObject({ acquirer: 'GHL', lines: 1, grossSen: 50000, feeSen: 2000, feePct: 4, bankChargeSen: 0, chargePct: 4 });
    /* The month across acquirers, and the grand total. */
    expect(june).toMatchObject({ lines: 3, grossSen: 350000, feeSen: 4400, netSen: 345600, feePct: 1.3, bankChargeSen: 32400, chargeSen: 36800, chargePct: 10.5 });
    expect(body.months[1]).toMatchObject({ month: '2026-07', lines: 1, grossSen: 100000, feeSen: 1790, feePct: 1.8, bankChargeSen: 0 });
    expect(body.totals).toMatchObject({ lines: 4, grossSen: 450000, feeSen: 6190, bankChargeSen: 32400, chargeSen: 38590, feePct: 1.4, chargePct: 8.6 });
  });

  test('confirmed-only leaves the unconfirmed month out; an acquirer filter keeps one merchant', async () => {
    const { app } = harness();
    const confirmed = await read(app, 'from=2026-06&to=2026-07&confirmed=1');
    expect(confirmed.body.confirmedOnly).toBe(true);
    expect(confirmed.body.months.map((m: any) => m.month)).toEqual(['2026-06']);
    expect(confirmed.body.totals).toMatchObject({ lines: 3, grossSen: 350000 });
    const ghl = await read(app, 'from=2026-06&to=2026-07&acquirer=ghl');
    expect(ghl.body.acquirer).toBe('GHL');
    expect(ghl.body.months).toHaveLength(1);
    expect(ghl.body.months[0].acquirers.map((a: any) => a.acquirer)).toEqual(['GHL']);
    expect(ghl.body.totals).toMatchObject({ lines: 1, grossSen: 50000, feeSen: 2000, bankChargeSen: 0 });
  });

  test('a bad range is refused, and the permission gate answers at this end', async () => {
    const { app } = harness();
    expect((await read(app, 'from=2026-07&to=2026-06')).status).toBe(400);
    expect((await read(app, 'from=2026-06-01&to=2026-07')).status).toBe(400);
    const { app: noPerm } = harness(['scm.access']);
    expect((await read(noPerm, 'from=2026-06&to=2026-07')).status).toBe(403);
  });
});
