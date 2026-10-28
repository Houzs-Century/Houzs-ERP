// Sales Invoice -> General Ledger posting: the only thing standing between one
// delivery and two bookings of its revenue. It auto-posts on every SI create
// and every confirm, which makes it the hottest money path in the system, and
// it shipped with no test of any kind.
//
// BUG-HISTORY records the twin: #690 hardened exactly this guard on the PURCHASE
// invoice side and left the SI original — the file the PI docblock says it
// "mirrors". Every case below asserts a DECISION and has been inverted in the
// source to confirm it fails.
//
// The fake answers like PostgREST: a column the table does not have fails the
// WHOLE query with 42703 and a null body. That is how a "the read did not
// answer" is simulated here, and it is the shape that matters — supabase-js
// does NOT throw, so `?? []` folds "we could not ask" into "there is nothing
// there", which does not degrade an idempotency guard, it DEFEATS it.

import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from './fake-postgrest';
import { postSiRevenue, reverseSiRevenue, resyncSiRevenue } from './post-si-revenue';

const INV = 'HC-SI-2608-001';

type World = {
  invoices?: Row[];
  /** The invoice's lines — their product group decides the sales account (docs/bugs/0829). */
  items?: Row[];
  /** scm.acc_item_group_accounts for company 1. */
  binds?: Row[];
  jes?: Row[];
  jeLines?: Row[];
  /** columns the query planner must not find — drives a 42703 on that read. */
  missing?: Record<string, string[]>;
};

const BINDS: Row[] = [
  { company_id: 1, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' },
  { company_id: 1, group_code: 'MATTRESS', sales_account: '500-0001', purchase_account: '601-0001' },
];

const world = ({ invoices, items, binds = BINDS, jes = [], jeLines = [], missing = {} }: World = {}) =>
  fakeSb(
    {
      sales_invoice_items: items ?? [
        { id: 'l-1', sales_invoice_id: 'si-1', item_group: 'sofa', line_total_sen: 388800 },
      ],
      acc_item_group_accounts: binds,
      sales_invoices: invoices ?? [
        {
          id: 'si-1',
          invoice_number: INV,
          invoice_date: '2026-08-01',
          debtor_code: 'C-001',
          debtor_name: 'Ah Meng Furnishing',
          total_sen: 388800,
          company_id: 1,
          status: 'ISSUED',
        },
      ],
      journal_entries: jes,
      journal_entry_lines: jeLines,
    },
    missing,
  );

const siJes = (sb: ReturnType<typeof fakeSb>) =>
  sb.tables.journal_entries.filter((j) => j.source_type === 'SI');

describe('postSiRevenue — booking the revenue once', () => {
  it('posts ONE balanced Dr Trade Debtor / Cr the product group\'s own sales account for the invoice total', async () => {
    const sb = world();
    const out = await postSiRevenue(sb, INV);
    expect(out).toMatchObject({ ok: true, status: 'posted', totalSen: 388800 });

    expect(siJes(sb)).toHaveLength(1);
    const je = siJes(sb)[0]!;
    expect(je).toMatchObject({ source_doc_no: INV, total_debit_sen: 388800, total_credit_sen: 388800, posted: true });

    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(lines.map((l) => [l.account_code, l.debit_sen, l.credit_sen])).toEqual([
      ['300-0000', 388800, 0],
      ['500-0003', 0, 388800],
    ]);
  });

  it('credits one line per product group (case-folded), and the header total is the law — the remainder lands on the largest group', async () => {
    /* Two sofa lines and one mattress line; a header discount of 1 sen makes
       the total one short of the lines, and the sen comes off the largest. */
    const sb = world({
      invoices: [{ id: 'si-1', invoice_number: INV, invoice_date: '2026-08-01', debtor_code: 'C-001', debtor_name: 'Ah Meng Furnishing', total_sen: 388799, company_id: 1, status: 'ISSUED' }],
      items: [
        { id: 'l-1', sales_invoice_id: 'si-1', item_group: 'sofa', line_total_sen: 200000 },
        { id: 'l-2', sales_invoice_id: 'si-1', item_group: 'Sofa', line_total_sen: 100000 },
        { id: 'l-3', sales_invoice_id: 'si-1', item_group: 'mattress', line_total_sen: 88800 },
      ],
    });
    const out = await postSiRevenue(sb, INV);
    expect(out).toMatchObject({ ok: true, status: 'posted', totalSen: 388799 });
    const je = siJes(sb)[0]!;
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(lines.map((l) => [l.account_code, l.debit_sen, l.credit_sen])).toEqual([
      ['300-0000', 388799, 0],
      ['500-0003', 0, 299999],
      ['500-0001', 0, 88800],
    ]);
  });

  it('a group with no sales account bound REFUSES by name and posts nothing; so does a line with no group; so does an invoice with no lines', async () => {
    const unbound = world({ items: [{ id: 'l-1', sales_invoice_id: 'si-1', item_group: 'dining', line_total_sen: 388800 }] });
    const r1 = await postSiRevenue(unbound, INV);
    expect(r1).toMatchObject({ ok: false, status: 'group_unbound' });
    expect(String((r1 as { reason?: string }).reason)).toContain('DINING');
    expect(String((r1 as { reason?: string }).reason)).toContain('Item Groups');
    expect(siJes(unbound)).toHaveLength(0);

    const ungrouped = world({ items: [{ id: 'l-1', sales_invoice_id: 'si-1', item_group: null, line_total_sen: 388800 }] });
    expect(await postSiRevenue(ungrouped, INV)).toMatchObject({ ok: false, status: 'line_ungrouped' });
    expect(siJes(ungrouped)).toHaveLength(0);

    const bare = world({ items: [] });
    expect(await postSiRevenue(bare, INV)).toMatchObject({ ok: false, status: 'no_lines' });
    expect(siJes(bare)).toHaveLength(0);
  });

  it('a SECOND call books nothing — one invoice, one revenue entry', async () => {
    // The double-billing case in its simplest form: create then confirm, or a
    // retry after a timeout. Both reach this function with the same invoice.
    const sb = world();
    const first = await postSiRevenue(sb, INV);
    const second = await postSiRevenue(sb, INV);

    expect(second).toMatchObject({ ok: true, status: 'already_posted' });
    expect((second as { jeId: string }).jeId).toBe((first as { jeId: string }).jeId);
    expect(siJes(sb)).toHaveLength(1);
    expect(sb.tables.journal_entry_lines).toHaveLength(2);
  });

  it('a FAILED idempotency read aborts and posts NOTHING', async () => {
    // The whole class, stated once: `?? []` on this read means "we could not ask"
    // arrives as "no entry exists yet", and the second Dr AR / Cr Sales is booked
    // against an invoice that already has one. Nothing is written before this
    // point, so aborting strands nothing — the next call posts it once.
    const sb = world({ missing: { journal_entries: ['reversed'] } });
    const out = await postSiRevenue(sb, INV);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('post_failed');
    expect(sb.tables.journal_entries).toHaveLength(0);
    expect(sb.tables.journal_entry_lines).toHaveLength(0);
  });

  it('a REVERSED entry does NOT block a fresh post', async () => {
    // resyncSiRevenue voids the stale entry and re-posts at the new total, so
    // treating any historical SI row as "already posted" would leave an edited
    // invoice with no revenue at all — the opposite error, equally expensive.
    const sb = world({
      jes: [{ id: 'je-old', je_no: 'JE-2608-0001', source_type: 'SI', source_doc_no: INV, reversed: true, total_debit_sen: 100000, posted: true }],
    });
    const out = await postSiRevenue(sb, INV);
    expect(out).toMatchObject({ ok: true, status: 'posted' });
    expect(siJes(sb)).toHaveLength(2);
  });

  it('refuses a zero-total invoice rather than booking an empty entry', async () => {
    const sb = world({ invoices: [{ id: 'si-1', invoice_number: INV, invoice_date: '2026-08-01', debtor_code: 'C', debtor_name: 'C', total_sen: 0, company_id: 1, status: 'ISSUED' }] });
    expect(await postSiRevenue(sb, INV)).toMatchObject({ ok: false, status: 'zero_total' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('reports a missing invoice instead of posting against nothing', async () => {
    const sb = world({ invoices: [] });
    expect(await postSiRevenue(sb, INV)).toMatchObject({ ok: false, status: 'invoice_not_found' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });
});

describe('reverseSiRevenue — voiding it once', () => {
  it('writes ONE mirror entry that nets the original to zero, and flags the original', async () => {
    const sb = world();
    await postSiRevenue(sb, INV);
    const out = await reverseSiRevenue(sb, INV);
    expect(out).toMatchObject({ ok: true, status: 'reversed' });

    const reversals = sb.tables.journal_entries.filter((j) => j.source_type === 'SI_REVERSAL');
    expect(reversals).toHaveLength(1);
    expect(siJes(sb)[0]).toMatchObject({ reversed: true, reversed_by_je: reversals[0]!.id });

    // Debit and credit swapped against the SAME accounts — a faithful contra.
    const revLines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === reversals[0]!.id);
    expect(revLines.map((l) => [l.account_code, l.debit_sen, l.credit_sen])).toEqual([
      ['300-0000', 0, 388800],
      ['500-0003', 388800, 0],
    ]);
  });

  it('a SECOND reversal books no second contra entry', async () => {
    const sb = world();
    await postSiRevenue(sb, INV);
    await reverseSiRevenue(sb, INV);
    const again = await reverseSiRevenue(sb, INV);
    expect(again).toMatchObject({ ok: true, status: 'nothing_to_reverse' });
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'SI_REVERSAL')).toHaveLength(1);
  });

  it('re-reverses nothing when the reversal exists but the flag never stuck', async () => {
    // A crash between "insert the contra" and "flag the original" leaves exactly
    // this state. Without the reversed_by_je guard the retry writes a SECOND
    // contra and the cancellation is over-reversed — revenue goes negative.
    const sb = world({
      jes: [
        { id: 'je-1', je_no: 'JE-2608-0001', source_type: 'SI', source_doc_no: INV, reversed: false, entry_date: '2026-08-01', total_debit_sen: 388800, total_credit_sen: 388800, company_id: 1, posted: true },
        { id: 'je-2', je_no: 'JE-2608-0002', source_type: 'SI_REVERSAL', source_doc_no: INV, reversed_by_je: 'je-1', entry_date: '2026-08-02', total_debit_sen: 388800, total_credit_sen: 388800, company_id: 1, posted: true },
      ],
    });
    const out = await reverseSiRevenue(sb, INV);
    expect(out).toMatchObject({ ok: true, status: 'already_reversed' });
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'SI_REVERSAL')).toHaveLength(1);
    expect(sb.tables.journal_entries.find((j) => j.id === 'je-1')).toMatchObject({ reversed: true });
  });

  it('a FAILED read of the original leaves the books alone and says so', async () => {
    // This used to answer { ok: true, nothing_to_reverse }: the caller cancels
    // the invoice, believes the GL was squared, and a live revenue entry stays
    // posted against a cancelled invoice with nothing scheduled to revisit it.
    const sb = world({
      jes: [{ id: 'je-1', je_no: 'JE-2608-0001', source_type: 'SI', source_doc_no: INV, reversed: false, entry_date: '2026-08-01', total_debit_sen: 388800, company_id: 1 }],
      missing: { journal_entries: ['reversed'] },
    });
    const out = await reverseSiRevenue(sb, INV);
    expect(out).toMatchObject({ ok: false, status: 'reversal_read_failed' });
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'SI_REVERSAL')).toHaveLength(0);
    expect(sb.tables.journal_entries.find((j) => j.id === 'je-1')).toMatchObject({ reversed: false });
  });
});

describe('resyncSiRevenue — keeping the GL equal to the invoice', () => {
  it('does nothing when the booked total already matches', async () => {
    const sb = world();
    await postSiRevenue(sb, INV);
    expect(await resyncSiRevenue(sb, INV)).toMatchObject({ ok: true, status: 'unchanged' });
    expect(siJes(sb)).toHaveLength(1);
  });

  it('voids the stale entry and re-posts at the NEW total', async () => {
    const sb = world();
    await postSiRevenue(sb, INV);
    sb.tables.sales_invoices[0]!.total_sen = 500000;

    expect(await resyncSiRevenue(sb, INV)).toMatchObject({ ok: true, status: 'resynced' });
    const live = siJes(sb).filter((j) => !j.reversed);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ total_debit_sen: 500000 });
  });

  it('a DRAFT invoice never posts revenue', async () => {
    // Posting happens on confirm. Editing a draft's lines must not leak revenue
    // into the GL for an invoice nobody has issued.
    const sb = world({ invoices: [{ id: 'si-1', invoice_number: INV, invoice_date: '2026-08-01', debtor_code: 'C', debtor_name: 'C', total_sen: 388800, company_id: 1, status: 'DRAFT' }] });
    expect(await resyncSiRevenue(sb, INV)).toMatchObject({ ok: true, status: 'not_posted' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('a CANCELLED invoice never re-posts revenue', async () => {
    const sb = world({ invoices: [{ id: 'si-1', invoice_number: INV, invoice_date: '2026-08-01', debtor_code: 'C', debtor_name: 'C', total_sen: 388800, company_id: 1, status: 'CANCELLED' }] });
    expect(await resyncSiRevenue(sb, INV)).toMatchObject({ ok: true, status: 'not_posted' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  it('a FAILED invoice read does NOT reverse the live entry', async () => {
    // The most destructive read in the file, and it reads as a lookup: a blip
    // left `si` null, the total folded to 0, and a healthy invoice lost its
    // revenue on a line edit while the caller was told it succeeded.
    const sb = world({ missing: { sales_invoices: ['status'] } });
    const posted = await postSiRevenue(sb, INV);
    expect(posted.ok).toBe(true);

    const out = await resyncSiRevenue(sb, INV);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('resync_read_failed');
    expect(siJes(sb).filter((j) => !j.reversed)).toHaveLength(1);
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'SI_REVERSAL')).toHaveLength(0);
  });
});
