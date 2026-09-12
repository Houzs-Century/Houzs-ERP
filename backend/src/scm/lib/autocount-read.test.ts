// ----------------------------------------------------------------------------
// autocount-read — the one read in the write-back that is about MONEY.
//
// WHAT THIS FILE IS FOR, and why it is its own suite. `soOutstandingSen`
// (scm/shared/so-outstanding.ts) is the ARITHMETIC and is pinned by its own
// tests; this is the READER, and the reader's job is to decide whether the ERP
// has anything to say at all. Those are different questions, and the defect
// this suite was opened for lived entirely in the second one: the arithmetic
// was right about `max(0, 0 - 160000)` and the reader should never have asked it
// OF `total_revenue_sen` alone. Since 2026-09-12 (AutoCount is push-only) the
// reader FALLS BACK to `local_total_sen` — the total a migrated order actually
// has — and answers; it refuses only when NEITHER column carries one. See
// autocount-read.ts's header for why that fallback is safe now.
//
// The BALANCE UDF goes into a LICENSED ACCOUNT BOOK. Every case below is
// therefore written as "what does the account book end up being told", not as
// "what number comes back".
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readSoOutstandingSen } from './autocount-read';
import { fakeSb, type Row } from './fake-postgrest';

/* THE CAST LIVES HERE AND NOWHERE ELSE. `fakeSb` answers the handful of
   PostgREST methods this module calls, not the 22 properties of a real
   `SupabaseClient`, so it needs one widening to be passed at all. Written once,
   against the reader's OWN parameter type — so if that signature changes, this
   line is what stops compiling rather than eleven call sites — and never as
   `as never`, which would switch the compiler off for the arguments too. */
type SbArg = Parameters<typeof readSoOutstandingSen>[0];
const asSb = (sb: ReturnType<typeof fakeSb>): SbArg => sb as unknown as SbArg;

/** One document's payment ledger, in the shape the reader selects. */
const sbWith = (payments: Row[]) => asSb(fakeSb({ mfg_sales_order_payments: payments }));

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
  /* THE 2026-09-12 CHANGE. Total 3,200 (carried in local_total_sen — a migrated
     order), paid 1,600. Until AutoCount went PUSH-ONLY the reader REFUSED here,
     to avoid overwriting the book's own UDF_BALANCE with a possibly-incomplete
     ERP figure. Now the ERP is the only way a balance reaches the book, so it
     FALLS BACK to local_total_sen and tells the book the real 1,600 — the fix
     for docs/bugs/0842 (34 migrated orders read as owing money already
     collected). */
  test('a part-paid migrated order now tells the book the real balance', async () => {
    expect(await readSoOutstandingSen(sbWith(halfPaid), migratedHeader)).toBe(1_600_00);
  });

  /* A migrated order collected IN FULL: the book is told 0, so the delivery
     sheet — which reads the balance from the book — stops showing money already
     received. */
  test('a fully-paid migrated order tells the book 0', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-012929', amount_sen: 3_200_00, is_deposit: false },
    ]), migratedHeader)).toBe(0);
  });

  /* The fallback is the SAME total the screen uses (soDisplayTotalSen): a
     total_revenue_sen that is not a positive number is not a total, so
     local_total_sen answers instead — NULL and negative both fall back. */
  test('a NULL total_revenue_sen falls back to local_total_sen', async () => {
    expect(await readSoOutstandingSen(sbWith(halfPaid), {
      ...migratedHeader, total_revenue_sen: null,
    })).toBe(1_600_00);
  });

  test('a negative total_revenue_sen falls back to local_total_sen', async () => {
    expect(await readSoOutstandingSen(sbWith(halfPaid), {
      ...migratedHeader, total_revenue_sen: -1_00,
    })).toBe(1_600_00);
  });

  /* ── WHAT IT STILL REFUSES ──────────────────────────────────────────────
     No total in EITHER column is "unknown", not "owes nothing": writing 0 into a
     licensed ledger would declare a real debt settled. */
  test('no total in either column refuses, even with nothing paid', async () => {
    expect(await readSoOutstandingSen(sbWith([]), {
      doc_no: 'HC-SO-012929', total_revenue_sen: 0, local_total_sen: 0, deposit_sen: 0,
    })).toBeNull();
  });

  test('a header that selected neither total column refuses', async () => {
    expect(await readSoOutstandingSen(sbWith(halfPaid), {
      doc_no: 'HC-SO-012929',
    })).toBeNull();
  });

  test('both totals negative refuses rather than clamping to 0', async () => {
    expect(await readSoOutstandingSen(sbWith([]), {
      doc_no: 'HC-SO-012929', total_revenue_sen: -1_00, local_total_sen: -1_00, deposit_sen: 0,
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
    const sb = asSb(fakeSb({ mfg_sales_order_payments: [] }, { mfg_sales_order_payments: ['amount_sen'] }));
    await expect(readSoOutstandingSen(sb, {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).rejects.toThrow(/mfg_sales_order_payments/);
  });
});
