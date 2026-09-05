// PI posting, the AutoCount periodic shape (GL redesign item 2). Pinned:
//   • a mixed invoice debits each group's OWN purchase account and credits the
//     supplier control with their exact sum — 330-0000 is not touched;
//   • an invoice whose group is unbound REFUSES with the group named, and
//     writes nothing (owner: 挡下来提醒我去绑,不要静默丢进 OTHERS);
//   • the sales panels write groups in lower-case, the registry in upper —
//     one case-fold, not two vocabularies;
//   • on a foreign invoice the per-group rounding remainder lands on the
//     largest group so the debits sum to EXACTLY the header's MYR;
//   • a line with no group, or an invoice with no lines, refuses by name.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { postPiAccounting } from '../src/scm/routes/accounting';

const CO = 2;

const CHART: Row[] = ['601-0003', '601-0001', '601-0004', '400-0000', '405-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: code.startsWith('4') ? 'LIABILITY' : 'EXPENSE',
  parent_code: null, is_active: true, company_id: CO,
}));

const BINDINGS: Row[] = [
  { company_id: CO, group_code: 'SOFA', purchase_account: '601-0003', sales_account: '501-0000', sales_return_account: '510-0000', purchase_return_account: '612-0000' },
  { company_id: CO, group_code: 'MATTRESS', purchase_account: '601-0001', sales_account: '501-0000', sales_return_account: '510-0000', purchase_return_account: '612-0000' },
];

const PI: Row = {
  id: 'pi1', invoice_number: '2990-PI-2609-010', invoice_date: '2026-09-01',
  supplier_id: 'sup1', total_sen: 255000, currency: 'MYR', exchange_rate: 1,
  company_id: CO, migrated_no_stock: false,
  suppliers: { code: '400-T005', name: 'TODERN HOME' },
};

const ITEMS: Row[] = [
  { purchase_invoice_id: 'pi1', item_group: 'sofa', line_total_sen: 155000, company_id: CO },
  { purchase_invoice_id: 'pi1', item_group: 'mattress', line_total_sen: 100000, company_id: CO },
];

const world = (over: Record<string, Row[]> = {}) => fakeSb({
  accounts: CHART.map((r) => ({ ...r })),
  acc_account_roles: [],
  acc_item_group_accounts: BINDINGS.map((r) => ({ ...r })),
  purchase_invoices: [{ ...PI }],
  purchase_invoice_items: ITEMS.map((r) => ({ ...r })),
  journal_entries: [],
  journal_entry_lines: [],
  ...over,
});

const lines = (sb: { tables: Record<string, Row[]> }) => sb.tables.journal_entry_lines;

describe('postPiAccounting — the periodic shape', () => {
  test('a mixed invoice debits each group\'s purchase account (lower-case lines folded up), credit is their sum', async () => {
    const sb = world();
    const r = await postPiAccounting(sb, '2990-PI-2609-010');
    expect(r).toMatchObject({ ok: true, status: 'posted' });

    const dr = lines(sb).filter((l) => Number(l.debit_sen) > 0)
      .map((l) => [l.account_code, Number(l.debit_sen)]);
    expect(dr).toEqual([['601-0003', 155000], ['601-0001', 100000]]);
    const cr = lines(sb).find((l) => Number(l.credit_sen) > 0)!;
    expect(cr).toMatchObject({ account_code: '400-0000', credit_sen: 255000 });
    expect(lines(sb).some((l) => l.account_code === '330-0000')).toBe(false);
  });

  test('an unbound group refuses with the group NAMED, and writes nothing', async () => {
    const sb = world({ acc_item_group_accounts: [BINDINGS[0]] }); // MATTRESS unbound
    const r = await postPiAccounting(sb, '2990-PI-2609-010');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('group_unbound');
    expect(String(r.reason)).toContain('MATTRESS');
    expect(String(r.reason)).toContain('Item Groups');
    expect(sb.tables.journal_entries).toHaveLength(0);
    expect(lines(sb)).toHaveLength(0);
  });

  test('a foreign invoice puts the rounding remainder on the largest group — debits sum to the header MYR exactly', async () => {
    const sb = world({
      purchase_invoices: [{ ...PI, total_sen: 100, currency: 'RMB', exchange_rate: 4.5 }],
      purchase_invoice_items: [
        { purchase_invoice_id: 'pi1', item_group: 'sofa', line_total_sen: 33, company_id: CO },
        { purchase_invoice_id: 'pi1', item_group: 'mattress', line_total_sen: 67, company_id: CO },
      ],
    });
    const r = await postPiAccounting(sb, '2990-PI-2609-010');
    expect(r).toMatchObject({ ok: true, totalSen: 450 }); // round(100 × 4.5)
    const dr = lines(sb).filter((l) => Number(l.debit_sen) > 0);
    expect(dr.reduce((s, l) => s + Number(l.debit_sen), 0)).toBe(450);
    // round(33×4.5)=149, round(67×4.5)=302 → drift −1 lands on MATTRESS.
    expect(dr.map((l) => [l.account_code, Number(l.debit_sen)])).toEqual([['601-0003', 149], ['601-0001', 301]]);
  });

  test('a line with no group refuses; an invoice with no lines refuses', async () => {
    const ungrouped = world({
      purchase_invoice_items: [{ purchase_invoice_id: 'pi1', item_group: null, line_total_sen: 255000, company_id: CO }],
    });
    const r1 = await postPiAccounting(ungrouped, '2990-PI-2609-010');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.status).toBe('line_ungrouped');

    const empty = world({ purchase_invoice_items: [] });
    const r2 = await postPiAccounting(empty, '2990-PI-2609-010');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.status).toBe('no_lines');
    expect(empty.tables.journal_entries).toHaveLength(0);
  });

  test('a migrated invoice still posts no journal — AutoCount owns that money', async () => {
    const sb = world({ purchase_invoices: [{ ...PI, migrated_no_stock: true }] });
    const r = await postPiAccounting(sb, '2990-PI-2609-010');
    expect(r).toMatchObject({ ok: true, status: 'migrated_source' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});
