/* The nine closing-stock accounts as scripts/seed-stock-bucket-accounts.mjs
   opens them (owner 2026-09-21: closing stock - customer / display /
   service; chart of account 那边也需要分出来). Pinned: one child per bucket
   under each of STOCK, STOCKS AT THE BEGINNING OF YEAR and STOCKS AT THE END
   OF YEAR, carrying the parent's type, section and special marker; the codes
   the ledger roles name (acc/rules.ts); a plan creates only what a company
   lacks and plans nothing under a parent the company does not carry. */
import { describe, expect, it } from 'vitest';
import { planFor, stockBucketAccounts } from '../scripts/lib/stock-bucket-accounts.mjs';
import { DEFAULT_ROLE_CODES, STOCK_BUCKET_ROLES } from '../src/acc/rules';

describe('the closing-stock bucket accounts', () => {
  it('are nine: a customer, display and service child under each of the three stock parents, the parent\'s type, section and marker', () => {
    const rows = stockBucketAccounts();
    expect(rows.map((r) => r.code)).toEqual(['330-0001', '330-0002', '330-0003', '600-0001', '600-0002', '600-0003', '620-0001', '620-0002', '620-0003']);
    expect(rows.find((r) => r.code === '330-0002')).toEqual({
      code: '330-0002', name: 'STOCK - DISPLAY', type: 'ASSET', parentCode: '330-0000', section: 'CURRENT ASSETS', special: 'SBS', bucket: 'display',
    });
    expect(rows.find((r) => r.code === '600-0001')).toMatchObject({ name: 'STOCKS AT THE BEGINNING OF YEAR - CUSTOMER', type: 'EXPENSE', parentCode: '600-0000', section: 'COST OF GOODS SOLD', special: 'SOS' });
    expect(rows.find((r) => r.code === '620-0003')).toMatchObject({ name: 'STOCKS AT THE END OF YEAR - SERVICE', type: 'EXPENSE', parentCode: '620-0000', section: 'COST OF GOODS SOLD', special: 'SCS' });
  });

  it('are the codes the ledger roles book on', () => {
    for (const bucket of ['customer', 'display', 'service'] as const) {
      const r = STOCK_BUCKET_ROLES[bucket];
      const codes = stockBucketAccounts().filter((a) => a.bucket === bucket).map((a) => a.code);
      expect([DEFAULT_ROLE_CODES[r.inventory], DEFAULT_ROLE_CODES[r.opening], DEFAULT_ROLE_CODES[r.closing]]).toEqual(codes);
    }
  });

  it('plans only what a company lacks, and nothing under a parent it does not carry', () => {
    const chart = [
      { code: '330-0000', parentCode: null, active: true },
      { code: '330-0001', parentCode: '330-0000', active: true },
      { code: '330-0002', parentCode: null, active: false },
      { code: '620-0000', parentCode: null, active: true },
    ];
    const plan = planFor(chart);
    expect(plan.parentsMissing).toEqual(['600-0000']);
    expect(plan.missing.map((a) => a.code)).toEqual(['330-0003', '620-0001', '620-0002', '620-0003']);
    expect(plan.present.map((a) => [a.code, a.active, a.parentOk])).toEqual([['330-0001', true, true], ['330-0002', false, false]]);
    /* A full chart plans nothing. */
    const full = planFor([...['330-0000', '600-0000', '620-0000'].map((code) => ({ code, parentCode: null })), ...stockBucketAccounts().map((a) => ({ code: a.code, parentCode: a.parentCode }))]);
    expect(full.missing).toEqual([]);
    expect(full.parentsMissing).toEqual([]);
  });
});
