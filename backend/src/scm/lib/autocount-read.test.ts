import { describe, expect, test } from 'vitest';
import { readSoOutstandingSen } from './autocount-read';
import { fakeSb, type Row } from './fake-postgrest';

type SbArg = Parameters<typeof readSoOutstandingSen>[0];
const asSb = (sb: ReturnType<typeof fakeSb>): SbArg => sb as unknown as SbArg;

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

  test('a fully-paid migrated order tells the book 0', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-012929', amount_sen: 3_200_00, is_deposit: false },
    ]), migratedHeader)).toBe(0);
  });

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


  test('a genuine total still computes exactly as before', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 200_00, is_deposit: false },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).toBe(300_00);
  });

  test('a SETTLED order still answers 0, so the book stops showing a debt', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 500_00, is_deposit: false },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).toBe(0);
  });

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

  test('an over-collected order is still clamped to 0, not negative', async () => {
    expect(await readSoOutstandingSen(sbWith([
      { so_doc_no: 'HC-SO-1', amount_sen: 800_00, is_deposit: false },
    ]), {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).toBe(0);
  });

  test('an unreadable payments ledger THROWS rather than reading as unpaid', async () => {
    const sb = asSb(fakeSb({ mfg_sales_order_payments: [] }, { mfg_sales_order_payments: ['amount_sen'] }));
    await expect(readSoOutstandingSen(sb, {
      doc_no: 'HC-SO-1', total_revenue_sen: 500_00, deposit_sen: 0,
    })).rejects.toThrow(/mfg_sales_order_payments/);
  });
});
