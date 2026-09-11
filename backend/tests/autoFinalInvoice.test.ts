/* The final invoice at delivery (owner 2026-09-12; docs/bugs/0830). Pinned:
     • the switch off: a delivered order is not invoiced;
     • the switch on: one sales invoice off every delivered line not yet
       billed — SENT, {co}-SI-YYMM-NNN, the order and delivery on it, the
       lines linked to the delivery lines, the revenue posted Dr AR (party
       the order's customer) / Cr each product group's sales account, the
       CREATE audit row naming the automation;
     • a second run finds the invoice and raises nothing beside it;
     • a line already billed by hand is left out; an order whose deliveries
       are all billed, or still drafts, raises nothing;
     • the picker route still converts through the same core.
   Same fake-PostgREST harness as tests/depositInvoices.test.ts. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { autoFinalInvoiceForOrder } from '../src/scm/lib/auto-final-invoice';
import { createSalesInvoiceFromDoLines } from '../src/scm/lib/si-from-do';

const CO = 2;
const SO = '2990-SO-2609-001';
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('500-0001', 'SALES OF BEDDING', 'INCOME'),
  acct('500-0003', 'SALES OF SOFA', 'INCOME'),
  acct('509-0000', 'DEPOSIT PAY BY CUSTOMER', 'INCOME'),
];
const ON = { company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01' };
const yymm = (): string => { const d = new Date(); return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`; };

const doLine = (id: string, over: Row = {}): Row => ({
  id, company_id: CO, delivery_order_id: 'do-1', item_code: 'SOFA-3S', item_group: 'sofa', description: '3-seater', description2: null, uom: 'UNIT',
  qty: 1, unit_price_sen: 200_000, unit_cost_sen: 100_000, discount_sen: 0, variants: null, line_delivery_date: null,
  gap_inches: null, divan_height_inches: null, divan_price_sen: 0, leg_height_inches: null, leg_price_sen: 0,
  custom_specials: null, line_suffix: null, special_order_price_sen: 0, line_no: 1, created_at: '2026-09-10T01:00:00Z', ...over,
});

function harness(opts: { settings?: Row[]; doStatus?: string; extraDos?: Row[]; extraLines?: Row[]; invoices?: Row[]; siItems?: Row[] } = {}) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990', name: '2990' }],
    acc_account_roles: [],
    acc_company_settings: (opts.settings ?? []).map((r) => ({ ...r })),
    acc_item_group_accounts: [
      { company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' },
      { company_id: CO, group_code: 'MATTRESS', sales_account: '500-0001', purchase_account: '601-0001' },
    ],
    mfg_sales_orders: [{ doc_no: SO, company_id: CO, status: 'DELIVERED', debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding' }],
    delivery_orders: [
      {
        id: 'do-1', company_id: CO, so_doc_no: SO, do_number: '2990-DO-2609-001', status: opts.doStatus ?? 'DELIVERED',
        debtor_code: null, debtor_name: 'Larding Chen', customer_delivery_date: '2026-09-10', phone: '0123456789', migrated_no_stock: false,
        salesperson_id: 'st-1', currency: 'MYR', do_date: '2026-09-10',
      },
      ...(opts.extraDos ?? []),
    ],
    delivery_order_items: [
      doLine('doi-1'),
      doLine('doi-2', { item_code: 'MAT-Q', item_group: 'mattress', description: 'Queen mattress', qty: 2, unit_price_sen: 50_000, unit_cost_sen: 20_000, line_no: 2 }),
      ...(opts.extraLines ?? []),
    ],
    sales_invoices: (opts.invoices ?? []).map((r) => ({ ...r })),
    sales_invoice_items: (opts.siItems ?? []).map((r) => ({ ...r })),
    sales_invoice_payments: [],
    mfg_sales_order_payments: [],
    journal_entries: [], journal_entry_lines: [],
    entity_audit_log: [],
  }, {}, [], ['journal_entry_lines']);
  return sb;
}
const sis = (sb: ReturnType<typeof harness>) => sb.tables.sales_invoices as Row[];
const jes = (sb: ReturnType<typeof harness>) => sb.tables.journal_entries as Row[];
const linesOf = (sb: ReturnType<typeof harness>, jeNo: string) => {
  const je = jes(sb).find((j) => j.je_no === jeNo)!;
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id)
    .map((l) => ({ code: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), party: l.party_code ?? null }));
};

describe('the final invoice at delivery', () => {
  test('the switch off: a delivered order is not invoiced', async () => {
    const sb = harness();
    expect(await autoFinalInvoiceForOrder(sb, { docNo: SO, companyId: CO, actorId: 'u-1' })).toEqual({ ok: true, status: 'switched_off' });
    expect(sis(sb)).toHaveLength(0);
    expect(await autoFinalInvoiceForOrder(sb, { docNo: SO, companyId: null, actorId: 'u-1' })).toEqual({ ok: true, status: 'no_company' });
  });

  test('the switch on: one SENT invoice off both delivered lines, revenue Dr AR (the customer) / Cr per group, the audit row names the automation', async () => {
    const sb = harness({ settings: [ON] });
    const r = await autoFinalInvoiceForOrder(sb, { docNo: SO, companyId: CO, actorId: 'u-1' });
    expect(r).toEqual({ ok: true, status: 'invoiced', invoiceNumber: `2990-SI-${yymm()}-001`, revenue: 'posted', lines: 2 });
    expect(sis(sb)).toHaveLength(1);
    const si = sis(sb)[0]!;
    expect(si).toMatchObject({
      company_id: CO, status: 'SENT', so_doc_no: SO, delivery_order_id: 'do-1', debtor_name: 'Larding Chen', created_by: 'u-1',
      total_sen: 300_000, subtotal_sen: 300_000, line_count: 2, mattress_sofa_sen: 300_000,
    });
    const items = (sb.tables.sales_invoice_items as Row[]).map((i) => [i.do_item_id, i.item_group, i.qty, i.line_total_sen, i.company_id]);
    expect(items).toEqual([['doi-1', 'sofa', 1, 200_000, CO], ['doi-2', 'mattress', 2, 100_000, CO]]);
    const je = jes(sb).find((j) => j.source_type === 'SI')!;
    expect(je).toMatchObject({ source_doc_no: si.invoice_number, company_id: CO });
    expect(linesOf(sb, String(je.je_no))).toEqual([
      { code: '300-0000', dr: 300_000, cr: 0, party: 'cust-larding' },
      { code: '500-0003', dr: 0, cr: 200_000, party: null },
      { code: '500-0001', dr: 0, cr: 100_000, party: null },
    ]);
    const audit = (sb.tables.entity_audit_log as Row[]).find((a) => a.action === 'CREATE');
    expect(audit).toMatchObject({ entity_type: 'SALES_INVOICE', entity_id: si.id });
    expect(String(audit?.note)).toContain('Auto: final invoice at delivery');
  });

  test('a second run finds the invoice and raises nothing beside it; a cancelled invoice does not count', async () => {
    const sb = harness({ settings: [ON] });
    await autoFinalInvoiceForOrder(sb, { docNo: SO, companyId: CO, actorId: 'u-1' });
    expect(await autoFinalInvoiceForOrder(sb, { docNo: SO, companyId: CO, actorId: 'u-1' })).toEqual({ ok: true, status: 'already_invoiced' });
    expect(sis(sb)).toHaveLength(1);
    /* Cancelled: the delivered lines are unbilled again — but the invoice's
       own lines still hold the qty until the cancel releases them, which is
       the picker's rule, not this hook's. Only the "live invoice" gate is
       pinned here. */
    sis(sb)[0]!.status = 'CANCELLED';
    const again = await autoFinalInvoiceForOrder(sb, { docNo: SO, companyId: CO, actorId: 'u-1' });
    expect(again.ok).toBe(true);
    expect(again.status).not.toBe('already_invoiced');
  });

  test('a line already billed by hand is left out; nothing to bill, or deliveries still drafts, raise nothing', async () => {
    /* doi-1 was invoiced by the picker earlier (a live invoice on ANOTHER
       order's paperwork would block; here the earlier invoice is on no order
       so only the line's remaining is in play). */
    const partial = harness({
      settings: [ON],
      invoices: [{ id: 'si-0', company_id: CO, invoice_number: '2990-SI-2608-001', so_doc_no: null, status: 'SENT', total_sen: 200_000, paid_sen: 0 }],
      siItems: [{ id: 'sii-0', sales_invoice_id: 'si-0', do_item_id: 'doi-1', qty: 1, line_total_sen: 200_000 }],
    });
    const r = await autoFinalInvoiceForOrder(partial, { docNo: SO, companyId: CO, actorId: 'u-1' });
    expect(r).toMatchObject({ ok: true, status: 'invoiced', lines: 1 });
    const raised = sis(partial).find((s) => s.so_doc_no === SO)!;
    expect(raised.total_sen).toBe(100_000);
    expect((partial.tables.sales_invoice_items as Row[]).filter((i) => i.sales_invoice_id === raised.id).map((i) => i.do_item_id)).toEqual(['doi-2']);

    const billed = harness({
      settings: [ON],
      invoices: [{ id: 'si-0', company_id: CO, invoice_number: '2990-SI-2608-001', so_doc_no: null, status: 'SENT', total_sen: 300_000, paid_sen: 0 }],
      siItems: [
        { id: 'sii-0', sales_invoice_id: 'si-0', do_item_id: 'doi-1', qty: 1, line_total_sen: 200_000 },
        { id: 'sii-1', sales_invoice_id: 'si-0', do_item_id: 'doi-2', qty: 2, line_total_sen: 100_000 },
      ],
    });
    expect(await autoFinalInvoiceForOrder(billed, { docNo: SO, companyId: CO, actorId: 'u-1' })).toEqual({ ok: true, status: 'nothing_to_invoice' });

    const draft = harness({ settings: [ON], doStatus: 'DRAFT' });
    expect(await autoFinalInvoiceForOrder(draft, { docNo: SO, companyId: CO, actorId: 'u-1' })).toEqual({ ok: true, status: 'nothing_to_invoice' });
    expect(sis(draft)).toHaveLength(0);
  });

  test('the picker path converts through the same core: a refused pick names its reason, a good pick raises the invoice', async () => {
    const sb = harness();
    const over = await createSalesInvoiceFromDoLines(sb, {
      companyId: CO, docPrefix: '2990-', picks: [{ doItemId: 'doi-1', qty: 5 }], asDraft: false, createdBy: 'u-1', actor: { id: 7, name: 'Chew' },
    });
    expect(over).toMatchObject({ ok: false, status: 409, body: { error: 'over_remaining', doItemId: 'doi-1', remaining: 1, requested: 5 } });
    expect(sis(sb)).toHaveLength(0);
    const none = await createSalesInvoiceFromDoLines(sb, { companyId: CO, docPrefix: '2990-', picks: [], asDraft: false, createdBy: 'u-1', actor: null });
    expect(none).toMatchObject({ ok: false, status: 400, body: { error: 'picks_required' } });
    const draft = await createSalesInvoiceFromDoLines(sb, {
      companyId: CO, docPrefix: '2990-', picks: [{ doItemId: 'doi-2', qty: 1 }], asDraft: true, createdBy: 'u-1', actor: { id: 7, name: 'Chew' },
    });
    expect(draft).toMatchObject({ ok: true, status: 201, body: { revenue: { posted: false, status: 'draft' }, creditApplied: 0 } });
    expect(sis(sb)[0]).toMatchObject({ status: 'DRAFT', total_sen: 50_000, line_count: 1 });
    expect(jes(sb)).toHaveLength(0);
  });
});
