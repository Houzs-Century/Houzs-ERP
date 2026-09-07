// The one-shot PI ledger repair (GL redesign item 3). Pinned:
//   • classification: no JE → missing; an ACTIVE JE debiting 330-0000 →
//     reshape; a JE already in the periodic shape → current (left alone);
//     drafts, cancelled and migrated invoices are not candidates at all;
//   • dryRun writes NOTHING and lists what a real run would do;
//   • the write pass posts the missing, reverses-and-re-posts the reshapes
//     (the old entry stays as a contra pair, never deleted), and reports an
//     unbound group as a per-invoice failure instead of dying;
//   • a second pass finds nothing left — the repair is idempotent.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { piPeriodicBackfill } from '../src/scm/routes/accounting-pi-backfill';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = ['601-0003', '601-0001', '330-0000', '400-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: code === '400-0000' ? 'LIABILITY' : 'EXPENSE',
  parent_code: null, is_active: true, company_id: CO,
}));

const BINDINGS: Row[] = [
  { company_id: CO, group_code: 'SOFA', purchase_account: '601-0003', sales_account: '501-0000', sales_return_account: '510-0000', purchase_return_account: '612-0000' },
];

const pi = (no: string, over: Row = {}): Row => ({
  id: `id-${no}`, invoice_number: no, invoice_date: '2026-08-01', supplier_id: 's1',
  total_sen: 100000, currency: 'MYR', exchange_rate: 1, company_id: CO, status: 'POSTED',
  migrated_no_stock: false, suppliers: { code: '400-T005', name: 'TODERN' }, ...over,
});
const item = (no: string, group = 'sofa', sen = 100000): Row => ({
  purchase_invoice_id: `id-${no}`, item_group: group, line_total_sen: sen, company_id: CO,
});

/** An OLD-shape journal (Dr 330 / Cr 400) for one invoice. */
const oldJe = (no: string, jeNo: string): { je: Row; lines: Row[] } => ({
  je: {
    id: `je-${no}`, je_no: jeNo, entry_date: '2026-08-01', source_type: 'PI', source_doc_no: no,
    company_id: CO, reversed: false, posted: true, total_debit_sen: 100000, total_credit_sen: 100000,
    narration: `Purchase invoice ${no}`,
  },
  lines: [
    { journal_entry_id: `je-${no}`, line_no: 1, account_code: '330-0000', debit_sen: 100000, credit_sen: 0, company_id: CO },
    { journal_entry_id: `je-${no}`, line_no: 2, account_code: '400-0000', debit_sen: 0, credit_sen: 100000, company_id: CO },
  ],
});

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = [GL_PERM]) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    acc_account_roles: [],
    acc_item_group_accounts: BINDINGS.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990' }],
    purchase_invoices: [],
    purchase_invoice_items: [],
    journal_entries: [],
    journal_entry_lines: [],
    ...tables,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.post('/accounting/backfill/pi-periodic', piPeriodicBackfill as never);
  return { app, sb };
}

const run = (app: Hono, qs = '') =>
  app.request(`/accounting/backfill/pi-periodic${qs}`, { method: 'POST' });

/** The three-invoice world: one missing, one old-shape, one already periodic,
    plus a draft and a migrated invoice that must not be candidates. */
function threeWorlds() {
  const old = oldJe('2990-PI-2607-001', '2990-JE-2607-0001');
  const cur = {
    je: {
      id: 'je-cur', je_no: '2990-JE-2608-0002', entry_date: '2026-08-02', source_type: 'PI',
      source_doc_no: '2990-PI-2608-002', company_id: CO, reversed: false, posted: true,
      total_debit_sen: 100000, total_credit_sen: 100000, narration: 'x',
    },
    lines: [
      { journal_entry_id: 'je-cur', line_no: 1, account_code: '601-0003', debit_sen: 100000, credit_sen: 0, company_id: CO },
      { journal_entry_id: 'je-cur', line_no: 2, account_code: '400-0000', debit_sen: 0, credit_sen: 100000, company_id: CO },
    ],
  };
  return harness({
    purchase_invoices: [
      pi('2990-PI-2607-001'),                                  // reshape
      pi('2990-PI-2608-001'),                                  // missing
      pi('2990-PI-2608-002'),                                  // current
      pi('2990-PI-2609-009', { status: 'DRAFT' }),             // never a candidate
      pi('2990-PI-2607-099', { migrated_no_stock: true }),     // AutoCount owns it
    ],
    purchase_invoice_items: [
      item('2990-PI-2607-001'), item('2990-PI-2608-001'), item('2990-PI-2608-002'),
      item('2990-PI-2609-009'), item('2990-PI-2607-099'),
    ],
    journal_entries: [old.je, cur.je],
    journal_entry_lines: [...old.lines, ...cur.lines],
  });
}

describe('POST /accounting/backfill/pi-periodic', () => {
  test('403 without the GL permission', async () => {
    const { app } = harness({}, []);
    expect((await run(app)).status).toBe(403);
  });

  test('dryRun classifies and writes nothing', async () => {
    const { app, sb } = threeWorlds();
    const res = await run(app, '?dryRun=1');
    expect(res.status).toBe(200);
    const body = await res.json() as { missing: Array<{ invoiceNumber: string }>; reshape: Array<{ invoiceNumber: string }>; current: number };
    expect(body.missing.map((i) => i.invoiceNumber)).toEqual(['2990-PI-2608-001']);
    expect(body.reshape.map((i) => i.invoiceNumber)).toEqual(['2990-PI-2607-001']);
    expect(body.current).toBe(1);
    expect(sb.tables.journal_entries).toHaveLength(2); // untouched
  });

  test('the write pass posts the missing, reshapes the old, leaves the current alone — and a second pass is empty', async () => {
    const { app, sb } = threeWorlds();
    const res = await run(app);
    expect(res.status).toBe(200);
    const body = await res.json() as { processed: Array<{ invoiceNumber: string; outcome: string }>; remaining: number; summary: { failed: number } };
    expect(body.summary.failed).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.processed.map((p) => [p.invoiceNumber, p.outcome])).toEqual([
      ['2990-PI-2607-001', 'reshaped'],
      ['2990-PI-2608-001', 'posted'],
    ]);

    // The old entry survives, reversed, with its contra — never deleted.
    const oldRow = sb.tables.journal_entries.find((j) => j.id === 'je-2990-PI-2607-001')!;
    expect(oldRow.reversed).toBe(true);
    const contra = sb.tables.journal_entries.find((j) => j.source_type === 'PI_REVERSAL' && j.source_doc_no === '2990-PI-2607-001')!;
    expect(contra).toBeTruthy();
    /* The contra carries the ORIGINAL's date — the invoice's month cancels
       within itself; a contra dated today left July/August over-stated on
       the live ledger (bug 0647). */
    expect(contra.entry_date).toBe('2026-08-01');

    // Both repaired invoices now carry an ACTIVE periodic entry (Dr 601-0003).
    for (const doc of ['2990-PI-2607-001', '2990-PI-2608-001']) {
      const active = sb.tables.journal_entries.find((j) => j.source_type === 'PI' && j.source_doc_no === doc && !j.reversed)!;
      const dr = sb.tables.journal_entry_lines.find((l) => l.journal_entry_id === active.id && Number(l.debit_sen) > 0)!;
      expect(dr.account_code).toBe('601-0003');
      // Dated by the INVOICE, so the payable lands back in its own month.
      expect(active.entry_date).toBe('2026-08-01');
    }

    // Second pass: nothing left to do.
    const again = await res.ok ? await run(app) : res;
    const body2 = await (again as Response).json() as { processed: unknown[]; remaining: number };
    expect(body2.processed).toEqual([]);
    expect(body2.remaining).toBe(0);
  });

  test('an unbound group fails THAT invoice by name; the rest still repair', async () => {
    const { app, sb } = threeWorlds();
    sb.tables.purchase_invoice_items.find((i) => i.purchase_invoice_id === 'id-2990-PI-2608-001')!.item_group = 'mattress';
    const res = await run(app);
    const body = await res.json() as { processed: Array<{ invoiceNumber: string; outcome: string; reason?: string }>; summary: { failed: number } };
    expect(body.summary.failed).toBe(1);
    const failed = body.processed.find((p) => p.invoiceNumber === '2990-PI-2608-001')!;
    expect(failed.outcome).toBe('failed');
    expect(String(failed.reason)).toContain('MATTRESS');
    const ok = body.processed.find((p) => p.invoiceNumber === '2990-PI-2607-001')!;
    expect(ok.outcome).toBe('reshaped');
  });
});
