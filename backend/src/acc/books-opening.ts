// ----------------------------------------------------------------------------
// acc/books-opening — the day a company's books start, and the stock they
// opened with (mig 20261028T2100; Houzs, owner 2026-10-28).
//
// Houzs keeps AutoCount as the book of record up to 31/08/2026 and the ERP
// from 01/09/2026 (「我在31/08 都在auto count做，31/08 之前我都是soft launch 的。
// 我会在01/09/2026当做正式在erp做，所以账的opening也是01/09/2026」). The two
// report views count a company's journals from its books_start_date on, plus
// the opening's own (journal_entries.opening) whatever their date. This file
// is the statements' half of the same rule: the STOCK.
//
// The statements take stock from the stock engine, not from the ledger
// (scm/routes/accounting-reports.ts). The engine replays every movement since
// the soft launch, so on 31/08 it holds what the ERP thought it had, not what
// the books opened with — AutoCount's figure (owner: 「1744164.68就当01/09 的
// opening stock，然后每天算closing stock 就可以了」). For a company whose books
// start on a day:
//   • a P&L whose range begins on or before the start opens on the books'
//     opening stock (nothing before the start is in the books); one that ends
//     before the start has no stock at all;
//   • the balance sheet's stock is the engine's from the start on, the
//     opening stock on the opening day (the old book's last day), nothing
//     before it; its earnings start FROM the opening stock — the opening
//     journal carries it on STOCKS AT THE BEGINNING (600-000x), a line the
//     statements set aside with the rest of the ledger's stock lines.
// A company without a start day reads exactly as before: the engine, always.
// ----------------------------------------------------------------------------

import { STOCK_BUCKETS, emptyBuckets, type StockBucket } from '../scm/lib/stock-bucket';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped in this family */
type Db = any;

export type BooksOpening = {
  /** The books' first day, YYYY-MM-DD. */
  booksStart: string;
  /** The day the opening is dated: the day before the start — the old book's last day. */
  openingDate: string;
  /** The stock the books opened with, per bucket, in sen. */
  stock: Record<StockBucket, number>;
  stockTotalSen: number;
  /** Set once the owner calls the opening final; the Opening Balance page then refuses every change. */
  lockedAt: string | null;
  lockedBy: string | null;
};

/** The day before a date, YYYY-MM-DD. */
export const dayBefore = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The stored opening_stock ({"customer": sen, …}) as whole sen per bucket. A
    key that is not a bucket, or an amount that is not whole sen, is refused —
    a wrong opening stock must stop the statement, never be read as nought. */
export function parseOpeningStock(v: unknown): { ok: true; stock: Record<StockBucket, number> } | { ok: false; reason: string } {
  const stock = emptyBuckets();
  if (v == null) return { ok: true, stock };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'opening_stock is not an object of buckets' };
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!(STOCK_BUCKETS as readonly string[]).includes(k)) return { ok: false, reason: `opening_stock names "${k}", which is not a stock bucket` };
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return { ok: false, reason: `opening_stock.${k} is not a whole number of sen` };
    stock[k as StockBucket] = n;
  }
  return { ok: true, stock };
}

/** The company's books opening; null when its books have no start day (every journal counts). */
export async function loadBooksOpening(sb: Db, companyId: number): Promise<{ ok: true; opening: BooksOpening | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_company_settings')
    .select('books_start_date, opening_stock, opening_locked_at, opening_locked_by')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, reason: `books opening: ${error.message}` };
  const row = (data ?? null) as { books_start_date?: string | null; opening_stock?: unknown; opening_locked_at?: string | null; opening_locked_by?: string | null } | null;
  const start = String(row?.books_start_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { ok: true, opening: null };
  const parsed = parseOpeningStock(row?.opening_stock);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return {
    ok: true,
    opening: {
      booksStart: start,
      openingDate: dayBefore(start),
      stock: parsed.stock,
      stockTotalSen: STOCK_BUCKETS.reduce((s, b) => s + parsed.stock[b], 0),
      lockedAt: row?.opening_locked_at ?? null,
      lockedBy: row?.opening_locked_by ?? null,
    },
  };
}

/** What a normal screen answers when asked to edit, post or cancel an opening
    document (journal_entries.opening and its bill / note / debtor bill): the
    books' 31/08 balance is changed on the Opening Balance page, which re-posts
    it as an opening entry and honours the lock. Re-posted by the normal path
    it would be booked as an ordinary entry dated before the books start — and
    the books would silently lose it. */
export const openingDocumentRefusal = (docNo: string): { error: 'opening_document'; message: string } => ({
  error: 'opening_document',
  message: `${docNo} is part of the books' opening balance — change it on Finance › Opening Balance.`,
});

/* ── Where a statement's stock comes from ───────────────────────────────── */

/** The engine as of the end of a date, or a figure the books fix (the opening stock, or nothing). */
export type StockFrom =
  | { from: 'engine'; date: string }
  | { from: 'fixed'; buckets: Record<StockBucket, number>; totalSen: number };

const nothing = (): StockFrom => ({ from: 'fixed', buckets: emptyBuckets(), totalSen: 0 });
const openingStock = (o: BooksOpening): StockFrom => ({ from: 'fixed', buckets: { ...o.stock }, totalSen: o.stockTotalSen });

/** A P&L for [from, to]: the stock it opens and closes on. */
export function pnlStockFrom(o: BooksOpening | null, from: string, to: string): { opening: StockFrom; closing: StockFrom } {
  if (o && to < o.booksStart) return { opening: nothing(), closing: nothing() };
  return {
    opening: o && from <= o.booksStart ? openingStock(o) : { from: 'engine', date: dayBefore(from) },
    closing: { from: 'engine', date: to },
  };
}

/** The balance sheet as at `asOf`: its stock, and the stock its earnings started from. */
export function balanceSheetStockFrom(o: BooksOpening | null, asOf: string): { opening: StockFrom; closing: StockFrom } {
  if (!o) return { opening: nothing(), closing: { from: 'engine', date: asOf } };
  if (asOf < o.openingDate) return { opening: nothing(), closing: nothing() };
  return { opening: openingStock(o), closing: asOf < o.booksStart ? openingStock(o) : { from: 'engine', date: asOf } };
}
