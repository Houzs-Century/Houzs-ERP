// ----------------------------------------------------------------------------
// autocount-read — the ERP reads the write-back composes FROM, and the one rule
// they all share: a read that FAILED must never look like a read that found
// nothing.
//
// SPLIT OUT OF autocount-outbox.ts on 2026-08-15, when the BALANCE UDF (module
// guide 7q) pushed that file back over the 2,000-line cap. It is the same kind
// of seam `autocount-masters.ts` was: `readOrThrow` and `AcReadError` are one
// self-contained idea that everything else in the outbox depends on, and
// `readSoOutstandingSen` is the only DB read in that module that is about
// MONEY — which is precisely the read worth being able to find.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import { poSourceRef, poTransferShape, type PoTransferShape } from '../shared/po-transfer-shape';
import { soOutstandingSen } from '../shared/so-outstanding';

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
 * `total_revenue_sen` on every write, so a row without one is a legacy or
 * half-built order the ERP cannot speak for — the key is omitted and the book
 * keeps whatever it holds. The SO detail page reads the same absence as 0
 * because it is drawing a screen; this is writing a ledger.
 */
export async function readSoOutstandingSen(
  sb: Sb,
  h: Record<string, unknown>,
): Promise<number | null> {
  const total = Number(h.total_revenue_sen);
  if (h.total_revenue_sen == null || !Number.isFinite(total)) return null;
  const rows = await readOrThrow('mfg_sales_order_payments',
    sb.from('mfg_sales_order_payments')
      .select('amount_sen, is_deposit')
      .eq('so_doc_no', String(h.doc_no ?? '')));
  let ledgerPaidSen = 0;
  let depositInLedger = false;
  for (const p of (rows ?? []) as Array<{ amount_sen?: number | null; is_deposit?: boolean | null }>) {
    ledgerPaidSen += Number(p.amount_sen ?? 0);
    if (p.is_deposit) depositInLedger = true;
  }
  return soOutstandingSen({
    totalRevenueSen: total,
    headerDepositSen: Number(h.deposit_sen ?? 0),
    ledgerPaidSen,
    depositInLedger,
  });
}

/**
 * One warehouse id -> the `dbo.Location` code AutoCount keys its stock by.
 *
 * The single-row twin of `withLocations` (autocount-outbox.ts), for a document's
 * HEADER warehouse (`scm.purchase_orders.purchase_location_id`). Not folded into
 * it because the two answer different questions: that one resolves a SET of line
 * warehouses and tolerates a line with none, this one resolves the order's own
 * default. It lives HERE for the reason this whole module exists — the outbox
 * file is at its 2,000-line cap, and this is a READ.
 *
 * A FAILED READ THROWS, the rule the top of this file states: null here means
 * "this purchase order has no ship-to warehouse", which `composeCreatePo` turns
 * into a refusal naming a remedy, and an unreadable `scm.warehouses` must not be
 * able to look like that.
 */
export async function readWarehouseCode(sb: Sb, warehouseId: unknown): Promise<string | null> {
  const id = typeof warehouseId === 'string' ? warehouseId.trim() : '';
  if (!id) return null;
  const row = await readOrThrow('warehouses',
    sb.from('warehouses').select('id, code, name').eq('id', id).maybeSingle());
  const w = row as { code?: string | null; name?: string | null } | null;
  /* `code` first, `name` as the fallback — exactly what `withLocations` does, so
     a warehouse row with a blank code resolves the same way on a header as it
     does on a line. */
  const code = ((w?.code ?? w?.name ?? '') as string).trim();
  return code || null;
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

/**
 * What SHAPE each purchase-order line has, for the SO-to-PO transfer decision.
 *
 * Three reads, because the answer lives in three tables and no join is
 * available through PostgREST's shape here: the lines, their allocations (mig
 * 0235 — present means CONSOLIDATED and authoritative), and the AutoCount key
 * of the sales-order line each one points at.
 *
 * A line whose source sales line the account book has never seen comes back
 * with a null key, which the decision reads as "cannot transfer" — correctly,
 * since a transfer is addressed by that key and by nothing else.
 */
export async function readPoTransferFacts(
  sb: Sb,
  poId: string,
): Promise<Array<{ id: string; so_item_id: string | null; allocationCount: number; sourceAcDtlKey: number | null; sourceSoDocNo: string | null; sourceSoInBook: boolean }>> {
  const rows = ((await readOrThrow('purchase_order_items',
    sb.from('purchase_order_items').select('id, so_item_id').eq('purchase_order_id', poId))) ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return [];

  const ids = rows.map((r) => String(r.id));
  const allocs = ((await readOrThrow('purchase_order_item_allocations',
    sb.from('purchase_order_item_allocations').select('purchase_order_item_id')
      .in('purchase_order_item_id', ids))) ?? []) as Array<Record<string, unknown>>;
  const allocCount = new Map<string, number>();
  for (const a of allocs) {
    const k = String(a.purchase_order_item_id ?? '');
    allocCount.set(k, (allocCount.get(k) ?? 0) + 1);
  }

  const soItemIds = [...new Set(rows.map((r) => (r.so_item_id == null ? null : String(r.so_item_id)))
    .filter((v): v is string => v !== null))];
  const keyOf = new Map<string, number>();
  const docOf = new Map<string, string>();
  const inBook = new Set<string>();
  if (soItemIds.length) {
    const soLines = ((await readOrThrow('mfg_sales_order_items',
      sb.from('mfg_sales_order_items').select('id, linked_ac_dtlkey, doc_no').in('id', soItemIds))) ?? []) as Array<Record<string, unknown>>;
    for (const l of soLines) {
      const k = Number(l.linked_ac_dtlkey);
      if (Number.isFinite(k) && k > 0) keyOf.set(String(l.id), k);
      const dn = String(l.doc_no ?? '').trim();
      if (dn) docOf.set(String(l.id), dn);
    }

    /* IS THE SALES ORDER IN THE BOOK YET — the fact that tells a MISSING key
       apart from an IMPOSSIBLE one.

       `linked_ac_dtlkey` is written when the sales order reaches AutoCount and
       the create hands back its line keys. A purchase order raised in the same
       minute therefore sees NULL keys, and poTransferShape used to read that as
       "the book has no key for these lines, so a transfer cannot address them"
       — true at that instant, false five minutes later, and never revisited.
       Measured on production 2026-08-25: HC-PO-2608-007 was raised from
       HC-SO-2608-008 and went as `create_po`, so the account book holds no link
       between them at all. Owner the next morning: 「明明我的 PO 是通过 Transfer
       from Sales Order 来开的，可是进到 AutoCount 那边…没有建立 Transaction
       Relationship」. The five POs before it transferred correctly — they were
       raised long enough after their sales orders. It is a race, not a rule. */
    const soDocNos = [...new Set([...docOf.values()])];
    if (soDocNos.length) {
      const sos = ((await readOrThrow('mfg_sales_orders',
        sb.from('mfg_sales_orders').select('doc_no, linked_ac_docno').in('doc_no', soDocNos))) ?? []) as Array<Record<string, unknown>>;
      for (const so of sos) {
        const dn = String(so.doc_no ?? '').trim();
        if (dn && String(so.linked_ac_docno ?? '').trim()) inBook.add(dn);
      }
    }
  }

  return rows.map((r) => {
    const soItemId = r.so_item_id == null ? null : String(r.so_item_id);
    return {
      id: String(r.id),
      so_item_id: soItemId,
      allocationCount: allocCount.get(String(r.id)) ?? 0,
      sourceAcDtlKey: soItemId ? (keyOf.get(soItemId) ?? null) : null,
      sourceSoDocNo: soItemId ? (docOf.get(soItemId) ?? null) : null,
      sourceSoInBook: soItemId ? inBook.has(docOf.get(soItemId) ?? '') : false,
    };
  });
}

/** The sales orders a purchase order was raised for, for its `Ref`. */
export async function readPoSourceSoDocNos(sb: Sb, poId: string): Promise<string[]> {
  const rows = ((await readOrThrow('purchase_order_items',
    sb.from('purchase_order_items').select('so_item_id').eq('purchase_order_id', poId))) ?? []) as Array<Record<string, unknown>>;
  const ids = [...new Set(rows.map((r) => (r.so_item_id == null ? null : String(r.so_item_id)))
    .filter((v): v is string => v !== null))];
  if (!ids.length) return [];
  const soLines = ((await readOrThrow('mfg_sales_order_items',
    sb.from('mfg_sales_order_items').select('doc_no').in('id', ids))) ?? []) as Array<Record<string, unknown>>;
  return soLines.map((l) => String(l.doc_no ?? '')).filter((d) => d !== '');
}

/**
 * The SO-to-PO decision, and the `Ref` that goes with the answer.
 *
 * Both reads and the rule in ONE call, because they are one question and
 * autocount-outbox.ts is at its size cap — the same reason `mastersOf` and the
 * reads above left that file. The rule itself stays pure in
 * `scm/shared/po-transfer-shape.ts`; this is the IO around it.
 */
export async function readPoEnqueueShape(
  sb: Sb,
  poId: string,
): Promise<{ shape: PoTransferShape; sourceRef: string | null }> {
  const shape = poTransferShape(await readPoTransferFacts(sb, poId));
  /* Only on the create path: a transfer needs no reference, because AutoCount's
     own DocTransfer link is a stronger one. */
  const sourceRef = shape.kind === 'transfer'
    ? null
    : poSourceRef(await readPoSourceSoDocNos(sb, poId));
  return { shape, sourceRef };
}
