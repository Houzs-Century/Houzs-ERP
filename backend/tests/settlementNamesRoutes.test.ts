// Merchant Recon, owner 2026-10-21 (「全部做，Pinelabs=AEON，Public=PBB」):
//   • Setup keeps a merchant's OTHER names, and one name belongs to one merchant;
//   • POST /rematch decides a merchant's open lines again for one company;
//   • the watch list lists a sale keyed under the other name, under that merchant;
//   • the report list is every report, not the newest 100.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  settlementSetupSave, settlementRematch, settlementWatchlist, settlementBatches, settlementMaintenance,
} from '../src/scm/routes/accounting-settlement';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const config = (code: string, soNames: string[]): Row => ({
  code, display_name: code, so_names: soNames, statement_format: 'CSV', has_unique_ref: true,
  fee_method: 'stated', date_tolerance_days: 7, column_map: { date: 'DATE', gross: 'GROSS', ref: 'APP. CODE' }, is_active: true,
});
const acquirer = (code: string, soNames: string[]): Row => ({
  ...config(code, soNames), company_id: CO,
  transit_account_code: '326-0000', fee_account_code: '900-T009', bank_account_code: '310-0010',
});

function harness(tables: Record<string, Row[]> = {}) {
  const sb = fakeSb(
    {
      accounts: [], acc_account_roles: [],
      acc_acquirer_config: [config('AEON', []), config('PBB', ['Public'])],
      acc_acquirers: [acquirer('AEON', ['Pinelabs']), acquirer('PBB', ['Public'])],
      acc_company_acquirers: [],
      acc_settlement_batches: [], acc_settlement_rows: [], acc_settlement_matches: [], acc_settlement_receipts: [],
      acc_settlement_payout_batches: [],
      mfg_sales_order_payments: [], sales_invoice_payments: [], mfg_sales_orders: [], sales_invoices: [], staff: [],
      ...tables,
    },
    {},
    [{ table: 'acc_settlement_matches', column: 'payment_id', name: 'acc_settlement_payment_once' }],
    ['acc_settlement_batches', 'acc_settlement_rows', 'acc_settlement_matches', 'acc_settlement_receipts'],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: [GL_PERM] } as never);
    c.set('allowedCompanyIds' as never, [1] as never);
    c.set('companies' as never, [{ id: 1, code: 'HOUZS', name: 'Houzs Century' }] as never);
    await next();
  });
  app.patch('/settlement/setup/:code', settlementSetupSave as never);
  app.post('/settlement/rematch', settlementRematch as never);
  app.get('/settlement/watchlist', settlementWatchlist as never);
  app.get('/settlement/batches', settlementBatches as never);
  app.get('/settlement/maintenance', settlementMaintenance as never);
  return { app, sb };
}

const send = (app: Hono, method: 'PATCH' | 'POST', path: string, body: Record<string, unknown>) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe("a merchant's other names, kept on Setup", () => {
  test('saved trimmed and de-duplicated; its own display name is not stored twice; maintenance reads them back', async () => {
    const { app, sb } = harness();
    const res = await send(app, 'PATCH', '/settlement/setup/AEON', { soNames: [' Pinelabs ', 'pinelabs', 'AEON', ''] });
    expect(res.status).toBe(200);
    expect(sb.tables.acc_acquirer_config.find((c) => c.code === 'AEON')?.so_names).toEqual(['Pinelabs']);
    const m = await (await app.request('/settlement/maintenance')).json() as { merchants: Array<{ code: string; so_names: string[] }> };
    expect(m.merchants.find((x) => x.code === 'AEON')?.so_names).toEqual(['Pinelabs']);
  });

  test("one name, one merchant — PBB's name is refused for AEON, naming PBB", async () => {
    const { app, sb } = harness();
    const res = await send(app, 'PATCH', '/settlement/setup/AEON', { soNames: ['Pinelabs', 'public'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'so_name_taken', message: `"public" is already PBB's name — one name can belong to one merchant only.` });
    expect(sb.tables.acc_acquirer_config.find((c) => c.code === 'AEON')?.so_names).toEqual([]);
  });
});

describe('POST /rematch', () => {
  test("decides a merchant's open lines again and says what changed", async () => {
    const { app, sb } = harness({
      acc_settlement_batches: [{ id: 1, company_id: CO, acquirer_code: 'AEON', period_from: '2026-09-05', period_to: '2026-09-05' }],
      acc_settlement_rows: [{ id: 11, batch_id: 1, company_id: CO, acquirer_code: 'AEON', line_no: 1, txn_date: '2026-09-05', ref: '090666', gross_sen: 700000, fee_sen: 0, net_sen: 700000, bucket: 'NEEDS_CONFIRM', confirmed_at: null }],
      mfg_sales_order_payments: [{ id: 'pA', company_id: CO, so_doc_no: 'SO-A', paid_at: '2026-09-05T11:00:00', amount_sen: 700000, approval_code: '090666', method: 'merchant', merchant_provider: 'Pinelabs' }],
    });
    const res = await send(app, 'POST', '/settlement/rematch', { companyId: CO, acquirerCode: 'AEON' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, acquirerCode: 'AEON', lines: 1, matched: 1, newlyMatched: 1 });
    expect(sb.tables.acc_settlement_rows[0]).toMatchObject({ bucket: 'MATCHED' });
  });

  test('a company the caller is not granted is refused', async () => {
    const { app } = harness();
    const res = await send(app, 'POST', '/settlement/rematch', { companyId: 2, acquirerCode: 'AEON' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'company_not_granted' });
  });
});

describe('the watch list and the report list', () => {
  test("a sale keyed under the merchant's other name is listed under that merchant", async () => {
    const { app } = harness({
      mfg_sales_order_payments: [{ id: 'pA', company_id: CO, so_doc_no: 'SO-A', paid_at: '2026-10-05T11:00:00', amount_sen: 700000, approval_code: '090666', method: 'merchant', merchant_provider: 'Pinelabs' }],
    });
    const body = await (await app.request('/settlement/watchlist?from=2026-10-01&to=2026-10-21')).json() as { recordedNotArrived: Array<{ id: string; acquirerCode: string | null }> };
    expect(body.recordedNotArrived.map((p) => [p.id, p.acquirerCode])).toEqual([['pA', 'AEON']]);
  });

  test('every report is listed — not the newest 100', async () => {
    const batches = Array.from({ length: 105 }, (_, i) => ({
      id: i + 1, company_id: CO, acquirer_code: 'AEON', file_name: `f${i}.csv`, period_from: '2026-09-01', period_to: '2026-09-01',
      row_count: 0, gross_sen: 0, fee_sen: 0, net_sen: 0, stated_net_sen: null, adjustment_sen: 0, adjustment_je_no: null,
      status: 'OPEN', created_at: `2026-10-21T03:${String(i % 60).padStart(2, '0')}:00Z`, uploaded_by: null,
    }));
    const { app } = harness({ acc_settlement_batches: batches });
    const body = await (await app.request('/settlement/batches')).json() as { batches: unknown[] };
    expect(body.batches).toHaveLength(105);
  });
});
