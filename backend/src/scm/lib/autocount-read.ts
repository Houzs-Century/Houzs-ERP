// ----------------------------------------------------------------------------
// autocount-read — the ERP reads the write-back composes FROM, and the one rule
// they all share: a read that FAILED must never look like a read that found
// nothing.
//
// SPLIT OUT OF autocount-outbox.ts on 2026-08-15, when the BALANCE UDF (module
// guide 7q) pushed that file back over the 2,000-line cap. It is the same kind
// of seam `autocount-masters.ts` was: `readOrThrow` and `AcReadError` are one
// self-contained idea that everything else in the outbox depends on, and
// `readSoOutstandingCenti` is the only DB read in that module that is about
// MONEY — which is precisely the read worth being able to find.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import { soOutstandingCenti } from '../shared/so-outstanding';

type Sb = SupabaseClient<any, any, any>;

/**
 * A read that FAILED, as opposed to a read that found nothing.
 *
 * The distinction is the whole point. PostgREST answers a bad column with an
 * error and a null body; `data ?? []` then turns a failure into "this document
 * has no lines", and the write-back composes a header with an empty Details
 * array — an order pushed into a live account book with nothing on it. Every
 * read therefore throws this instead of defaulting.
 */
export class AcReadError extends Error {}

export async function readOrThrow<T>(
  what: string,
  q: PromiseLike<{ data: T; error: { code?: string; message?: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error) throw new AcReadError(`${what}: ${error.code ?? ''} ${error.message ?? ''}`.trim());
  return data;
}

/**
 * What the sales order still owes, in sen — AutoCount's `UDF_BALANCE`.
 *
 * THE ERP HOLDS THIS IN THREE PLACES AND THE OBVIOUS ONE IS WRONG. The rule is
 * `scm/shared/so-outstanding.ts`, lifted out of `GET /mfg-sales-orders/:docNo`
 * so the account book and the SO detail page cannot compute different numbers;
 * this is only the READ, the same division `withLocations` and
 * `readSalespersonName` draw for the warehouse and the salesperson.
 *
 * WHY THE BOOK'S FIELD AND THE ERP'S NUMBER ARE THE SAME QUANTITY, rather than
 * two things that happen to look alike: the cutover turned one INTO the other.
 * `import-ac-outstanding-so.mjs:294` computed `paid = total - UDF_BALANCE` and
 * wrote that as a payments-ledger row, so `total - SUM(payments)` reproduces
 * `UDF_BALANCE` for every imported order by construction.
 *
 * A FAILED READ THROWS rather than degrading to zero, and A MISSING TOTAL
 * ANSWERS `null`. Both guard the same trap from opposite sides: zero is not
 * "unknown", it is "this customer owes nothing", and writing it into a live
 * account book declares a real debt settled. `recomputeTotals` fills
 * `total_revenue_centi` on every write, so a row without one is a legacy or
 * half-built order the ERP cannot speak for — the key is omitted and the book
 * keeps whatever it holds. The SO detail page reads the same absence as 0
 * because it is drawing a screen; this is writing a ledger.
 */
export async function readSoOutstandingCenti(
  sb: Sb,
  h: Record<string, unknown>,
): Promise<number | null> {
  const total = Number(h.total_revenue_centi);
  if (h.total_revenue_centi == null || !Number.isFinite(total)) return null;
  const rows = await readOrThrow('mfg_sales_order_payments',
    sb.from('mfg_sales_order_payments')
      .select('amount_centi, is_deposit')
      .eq('so_doc_no', String(h.doc_no ?? '')));
  let ledgerPaidCenti = 0;
  let depositInLedger = false;
  for (const p of (rows ?? []) as Array<{ amount_centi?: number | null; is_deposit?: boolean | null }>) {
    ledgerPaidCenti += Number(p.amount_centi ?? 0);
    if (p.is_deposit) depositInLedger = true;
  }
  return soOutstandingCenti({
    totalRevenueCenti: total,
    headerDepositCenti: Number(h.deposit_centi ?? 0),
    ledgerPaidCenti,
    depositInLedger,
  });
}

/**
 * The payment REFERENCES this order carries, oldest first, for the `PAYEMENT`
 * UDF.
 *
 * A SEPARATE READ FROM THE BALANCE ABOVE, on purpose. That one needs two
 * numeric columns off every row and collapses them to one figure; this one
 * needs two text columns and the ORDER they were taken in, because the field it
 * builds is read by a person. Merging them would make one caller pay for the
 * other's columns on every document, and would tie a money rule to a text one.
 *
 * Ordered by `paid_at` then `id` — `paid_at` is a DATE on this table, so a
 * day with two payments has no order of its own and would otherwise reshuffle
 * between reads, rewriting the account book's text for no reason on every edit.
 */
export async function readSoPaymentRefs(
  sb: Sb,
  docNo: string,
): Promise<Array<{ account_sheet: string | null; approval_code: string | null }>> {
  const rows = await readOrThrow('mfg_sales_order_payments',
    sb.from('mfg_sales_order_payments')
      .select('account_sheet, approval_code, paid_at, id')
      .eq('so_doc_no', docNo)
      .order('paid_at', { ascending: true })
      .order('id', { ascending: true }));
  return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    account_sheet: (r.account_sheet as string | null) ?? null,
    approval_code: (r.approval_code as string | null) ?? null,
  }));
}
