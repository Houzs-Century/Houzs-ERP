/* Editing a payment must move its journal entry with it.
 *
 * `PATCH /:docNo/payments/:id` has never touched the ledger — it writes the
 * row, recomputes the invoice, queues an AutoCount edit and stops. Step 1
 * (docs/bugs/0774) made the resulting divergence visible; this is step 2,
 * which stops it happening: reverse the old entry and book a fresh one, the
 * pattern general receipts already use.
 *
 * Two decisions are pinned here and neither is obvious.
 *
 * WHICH EDITS MOVE THE BOOKS. Only four of a payment's fields reach the
 * ledger: the amount, the date, the method (it picks the debit account) and
 * the acquirer behind a card payment (it picks WHICH transit account). An
 * approval code, an account sheet, a collector, an installment term — none of
 * them change a single line, and re-posting for those would churn the ledger
 * and spend a JE number for nothing.
 *
 * WHERE THE CONTRA IS DATED. On the ORIGINAL entry's date, not today. An edit
 * is a correction of a mistake made that day, not a new event — so the wrong
 * entry and its reversal must net to zero in the month they were made. Dated
 * today instead, a corrected RM 1,990 would leave that money standing in one
 * month's bank column and a matching negative in another, which is exactly
 * what the bank reconciliation this work exists to serve cannot absorb.
 * (DELETE is deliberately left alone: removing a payment IS an event today.)
 */
import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { ledgerBearingChange, repostSoPaymentEdit, type PaymentLedgerFacts } from './payment-repost';
import { postSoPayment, type SoPaymentRow } from './payments';
import { DEFAULT_ROLE_CODES } from './rules';

const CHART: Row[] = ['300-0000', '500-0000', '320-0000', '310-0010', '888-0000', '999-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, company_id: 1,
}));

const SO: Row = { doc_no: 'SO-2609-001', company_id: 1, debtor_name: 'Ah Meng', phone: '0123', customer_id: 'cust-1', debtor_code: null };

const PAY = (over: Partial<Row> = {}): Row => ({
  id: 'pay-1',
  so_doc_no: 'SO-2609-001',
  paid_at: '2026-09-01T14:00:00+08:00',
  method: 'cash',
  merchant_provider: null,
  amount_sen: 199_000,
  company_id: 1,
  ...over,
});

const facts = (over: Partial<PaymentLedgerFacts> = {}): PaymentLedgerFacts => ({
  amountSen: 199_000, paidOn: '2026-09-01', method: 'cash', merchantProvider: null, ...over,
});

const world = () => fakeSb({
  accounts: CHART,
  acc_account_roles: [],
  acc_acquirers: [
    { company_id: 1, code: 'MBB', display_name: 'MBB', transit_account_code: '888-0000', is_active: true },
    { company_id: 1, code: 'PBB', display_name: 'PBB', transit_account_code: '999-0000', is_active: true },
  ],
  mfg_sales_orders: [SO],
  mfg_sales_order_payments: [PAY()],
  journal_entries: [],
  journal_entry_lines: [],
});

/* The state every re-post test starts from: the payment already booked once,
   the way the sales panel books it. */
const booked = async () => {
  const sb = world();
  const out = await postSoPayment(sb, PAY() as unknown as SoPaymentRow);
  expect(out).toMatchObject({ ok: true, status: 'posted' });
  return sb;
};

const active = (sb: ReturnType<typeof world>) =>
  sb.tables.journal_entries.filter((j: Row) => j.source_type === 'SOPAY' && !j.reversed);

describe('ledgerBearingChange — which edits move the books', () => {
  it('an unchanged payment moves nothing', () => {
    expect(ledgerBearingChange(facts(), facts())).toEqual([]);
  });

  it('names the amount, the date, the method and the acquirer', () => {
    expect(ledgerBearingChange(facts(), facts({ amountSen: 199_100 }))).toEqual(['amount']);
    expect(ledgerBearingChange(facts(), facts({ paidOn: '2026-09-04' }))).toEqual(['date']);
    expect(ledgerBearingChange(facts(), facts({ method: 'transfer' }))).toEqual(['method']);
    expect(ledgerBearingChange(
      facts({ method: 'merchant', merchantProvider: 'MBB' }),
      facts({ method: 'merchant', merchantProvider: 'PBB' }),
    )).toEqual(['acquirer']);
  });

  it('names every field that moved, in one answer', () => {
    expect(ledgerBearingChange(facts(), facts({ amountSen: 1, paidOn: '2026-09-09', method: 'transfer' })))
      .toEqual(['amount', 'date', 'method']);
  });

  it('an acquirer on a method that does not use one is not a ledger change', () => {
    /* cash and transfer never reach transitFor, so the provider cannot pick an
       account — and the route nulls it out anyway. */
    expect(ledgerBearingChange(facts(), facts({ merchantProvider: 'MBB' }))).toEqual([]);
  });

  it('a blank acquirer and an absent one are the same acquirer', () => {
    expect(ledgerBearingChange(
      facts({ method: 'merchant', merchantProvider: '' }),
      facts({ method: 'merchant', merchantProvider: null }),
    )).toEqual([]);
  });

  it('reads the date off a timestamp, so a changed clock time is not a changed date', () => {
    expect(ledgerBearingChange(
      facts({ paidOn: '2026-09-01T09:00:00+08:00' }),
      facts({ paidOn: '2026-09-01T21:30:00+08:00' }),
    )).toEqual([]);
  });
});

describe('repostSoPaymentEdit — the entry follows the payment', () => {
  it('an edit that touches nothing the ledger cares about leaves the entry alone', async () => {
    const sb = await booked();
    const jeNoBefore = active(sb)[0].je_no;
    const out = await repostSoPaymentEdit(sb, { before: facts(), after: PAY() as unknown as SoPaymentRow });
    expect(out).toMatchObject({ ok: true, status: 'unchanged', moved: [] });
    expect(sb.tables.journal_entries).toHaveLength(1);
    expect(active(sb)[0].je_no).toBe(jeNoBefore);
  });

  it('a corrected AMOUNT reverses the old entry and books the new figure', async () => {
    const sb = await booked();
    const out = await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ amount_sen: 199_100 }) as unknown as SoPaymentRow,
    });
    expect(out).toMatchObject({ ok: true, status: 'reposted', moved: ['amount'] });

    /* Exactly one entry still speaks for this payment, and it says the new
       figure. The old one is reversed, not deleted. */
    const live = active(sb);
    expect(live).toHaveLength(1);
    expect(live[0].total_debit_sen).toBe(199_100);
    expect(sb.tables.journal_entries.filter((j: Row) => j.reversed)).toHaveLength(1);

    const lines = sb.tables.journal_entry_lines.filter((l: Row) => l.journal_entry_id === live[0].id);
    expect(lines[0]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.CASH, debit_sen: 199_100 });
    expect(lines[1]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.AR, credit_sen: 199_100 });
  });

  it('the contra sits on the ORIGINAL entry date, so the month it was booked in nets to zero', async () => {
    const sb = await booked();
    await repostSoPaymentEdit(sb, { before: facts(), after: PAY({ amount_sen: 199_100 }) as unknown as SoPaymentRow });
    const contra = sb.tables.journal_entries.find((j: Row) => String(j.source_type).endsWith('_REVERSAL'))!;
    expect(contra.entry_date).toBe('2026-09-01');
  });

  it('a corrected DATE moves the new entry, and the contra stays on the old one', async () => {
    const sb = await booked();
    const out = await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ paid_at: '2026-09-04T10:00:00+08:00' }) as unknown as SoPaymentRow,
    });
    expect(out).toMatchObject({ ok: true, status: 'reposted', moved: ['date'] });
    expect(active(sb)[0].entry_date).toBe('2026-09-04');
    const contra = sb.tables.journal_entries.find((j: Row) => String(j.source_type).endsWith('_REVERSAL'))!;
    expect(contra.entry_date).toBe('2026-09-01');
  });

  it('a corrected METHOD moves the money to the account that method debits', async () => {
    const sb = await booked();
    const out = await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ method: 'transfer' }) as unknown as SoPaymentRow,
    });
    expect(out).toMatchObject({ ok: true, status: 'reposted', moved: ['method'] });
    const live = active(sb)[0];
    const lines = sb.tables.journal_entry_lines.filter((l: Row) => l.journal_entry_id === live.id);
    expect(lines[0]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.BANK_DEFAULT, debit_sen: 199_000 });
  });

  it('a corrected ACQUIRER moves the money to that acquirer\'s own transit account', async () => {
    const sb = await booked();
    /* First make it a card payment on MBB, then correct the bank to PBB. */
    await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ method: 'merchant', merchant_provider: 'MBB' }) as unknown as SoPaymentRow,
    });
    const out = await repostSoPaymentEdit(sb, {
      before: facts({ method: 'merchant', merchantProvider: 'MBB' }),
      after: PAY({ method: 'merchant', merchant_provider: 'PBB' }) as unknown as SoPaymentRow,
    });
    expect(out).toMatchObject({ ok: true, status: 'reposted', moved: ['acquirer'] });
    const live = active(sb);
    expect(live).toHaveLength(1);
    const lines = sb.tables.journal_entry_lines.filter((l: Row) => l.journal_entry_id === live[0].id);
    expect(lines[0]).toMatchObject({ account_code: '999-0000', debit_sen: 199_000 });
  });

  it('re-posting twice converges — it does not stack entries', async () => {
    const sb = await booked();
    for (let i = 0; i < 3; i += 1) {
      await repostSoPaymentEdit(sb, { before: facts(), after: PAY({ amount_sen: 199_100 }) as unknown as SoPaymentRow });
    }
    expect(active(sb)).toHaveLength(1);
    expect(active(sb)[0].total_debit_sen).toBe(199_100);
  });

  it('a payment that never booked is simply booked — there is nothing to reverse', async () => {
    const sb = world();
    const out = await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ amount_sen: 199_100 }) as unknown as SoPaymentRow,
    });
    expect(out).toMatchObject({ ok: true, status: 'reposted', moved: ['amount'] });
    expect(active(sb)).toHaveLength(1);
    expect(sb.tables.journal_entries.filter((j: Row) => j.reversed)).toHaveLength(0);
  });

  it('an imported row is left where AutoCount put it, even when the figure moved', async () => {
    const sb = world();
    const out = await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ method: 'imported', amount_sen: 199_100 }) as unknown as SoPaymentRow,
    });
    expect(out).toMatchObject({ ok: true, status: 'not_booked' });
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  /* THE STATE THAT MUST NEVER HAPPEN: the old entry reversed and no new one
     written, silently. It CAN happen — a chart change can make the new method's
     account unpostable between the two steps — so it must come back as a
     refusal the caller can log, not as an ok. The payment then has no active
     entry, which is the Self-check unbooked card's finding and the backfill's
     to heal. */
  it('a re-post the gate refuses comes back as a refusal, naming the reason', async () => {
    const sb = await booked();
    for (const a of sb.tables.accounts) if (a.account_code === DEFAULT_ROLE_CODES.BANK_DEFAULT) a.is_active = false;
    const out = await repostSoPaymentEdit(sb, {
      before: facts(),
      after: PAY({ method: 'transfer' }) as unknown as SoPaymentRow,
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('repost_failed');
    expect(active(sb)).toHaveLength(0);
  });
});
