// ----------------------------------------------------------------------------
// autocount-read — the one read in the write-back that is about MONEY.
//
// WHAT THIS FILE IS FOR, and why it is its own suite. `soOutstandingSen`
// (scm/shared/so-outstanding.ts) is the ARITHMETIC and is pinned by its own
// tests; this is the READER, and the reader's job is to decide whether the ERP
// has anything to say at all. Those are different questions, and the defect
// this suite was opened for lived entirely in the second one: the arithmetic
// was right about `max(0, 0 - 160000)` and the reader should never have asked
// it.
//
// The BALANCE UDF goes into a LICENSED ACCOUNT BOOK. Every case below is
// therefore written as "what does the account book end up being told", not as
// "what number comes back".
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readSoOutstandingSen } from './autocount-read';
import { fakeSb, type Row } from './fake-postgrest';

/** One document's payment ledger, in the shape the reader selects. */
const sbWith = (payments: Row[]) => fakeSb({ mfg_sales_order_payments: payments });

/* The owner's own order, as the cutover left it in the database: the total is
   in `local_total_sen` because the importer's HCOLS does not carry
   `total_revenue_sen`, and that column is `integer DEFAULT 0 NOT NULL`.
   docs/bugs/0723-*. */
const migratedHeader = {
  doc_no: 'HC-SO-012929',
  total_revenue_sen: 0,
  local_total_sen: 3_200_00,
  deposit_sen: 0,
};

const halfPaid = [{ so_doc_no: 'HC-SO-012929', amount_sen: 1_600_00, is_deposit: false }];

describe('readSoOutstandingSen — when the ERP may speak for a licensed ledger', () => {
  /* THE DEFECT. Total 3,200, paid 1,600, and the ERP was about to write
     UDF_BALANCE = 0.00 into the account book — "this customer owes nothing"
     about a customer who owes 1,600. The reader must refuse instead: AutoCount
     then keeps its own UDF_BALANCE, which is the figure the cutover READ, and
     is right. */
  test('a part-paid migrated order does NOT answer 0 — it refuses', async () => {
    const answer = await readSoOutstandingSen(sbWith(halfPaid), migratedHeader);
    expect(answer).not.toBe(0);
    expect(answer).toBeNull();
  });

  /* The same judgement one step removed from the money: a zero total with no
     payments at all is still "the ERP does not know this order's total", and
     an assertion of 0 would be a coincidence rather than a fact. */
  test('a zero total refuses even when nothing has been paid', async () => {
    expect(await readSoOutstandingSen(sbWith([]), migratedHeader)).toBeNull();
  });

  /* The guard that already existed, kept. It cannot fire against the live
     schema — the column is NOT NULL — but it fires when the caller's SELECT
     list omits it, which is the shape a future header-column edit would take. */
  test('a NULL total still refuses, as it always has', async () => {
    expect(await readSoOutstandingSen(sbWith(halfPaid), {
      ...migratedHeader, total_revenue_sen: null,
    })).toBeNull();
  });

  test('a missing column — the caller never selected it — refuses', async () => {
    expect(await readSoOutstandingSen(sbWith(halfPaid), {
      doc_no: 'HC-SO-012929',
    })).toBeNull();
  });

  /* A NEGATIVE total is not a balance either, and `max(0, ...)` would have
     turned it into a confident 0. Same class, caught by the same `> 0`. */
  test('a negative total refuses rather than clamping to 0', async () => {
    expect(await readSoOutstandingSen(sbWith([]), {
      ...migratedHeader, total_revenue_sen: -1_00,
    })).toBeNull();
  });

  /* ── WHAT MUST NOT MOVE ────────────────────────────────────────────────
     Everything below is today's behaviour on an order the ERP DOES have a
     total for. The fix is allowed to make the reader quieter; it is not
     allowed to make it wrong. */

  test('a genuine total still computes exactly as before', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 200_00, is_deposit: false },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).toBe(300_00);
  });

  /* "ZERO IS A VALUE" — the rule the guide states and the one a `> 0` guard
     could plausibly have broken. A SETTLED order has a real positive total, so
     it is still answered, and still answered as 0, so the account book stops
     showing a debt the customer has paid. Refusing here would leave every paid
     order owing money in the book forever. */
  test('a SETTLED order still answers 0, so the book stops showing a debt', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 500_00, is_deposit: false },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).toBe(0);
  });

  /* The legacy header deposit counts once, and only when the ledger has no
     is_deposit row of its own. Unchanged by this fix and pinned so it stays
     that way. */
  test('the legacy header deposit still counts once', async () => {
    expect(await readSoOutstandingSen(sbWith([]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 100_00,
    })).toBe(400_00);
  });

  test('and does NOT double count when the ledger already carries it', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 100_00, is_deposit: true },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 100_00,
    })).toBe(400_00);
  });

  /* An over-collection is still clamped: AutoCount is a licensed ledger and a
     negative UDF_BALANCE is not what the ERP pushes into it. The SCREEN goes
     signed and red; this does not. */
  test('an over-collected order is still clamped to 0, not negative', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 800_00, is_deposit: false },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).toBe(0);
  });

  /* A READ THAT FAILED IS NOT A READ THAT FOUND NOTHING — the rule at the top
     of the module. A payments table the edge cannot answer for must throw, not
     degrade into "nothing has been paid, so the whole total is outstanding".
     `missing` makes fakeSb answer 42703 for the whole query, as PostgREST does. */
  test('an unreadable payments ledger THROWS rather than reading as unpaid', async () => {
    const sb = fakeSb({ mfg_sales_order_payments: [] }, { mfg_sales_order_payments: ['amount_sen'] });
    await expect(readSoOutstandingSen(sb, {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).rejects.toThrow(/mfg_sales_order_payments/);
  });
});
