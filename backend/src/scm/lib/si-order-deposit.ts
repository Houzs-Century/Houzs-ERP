// ----------------------------------------------------------------------------
// si-order-deposit — the deposit taken on a SALES ORDER, seen from the SALES
// INVOICES raised off that order.
//
// THE PROBLEM THIS EXISTS FOR. Money arrives on two ledgers that never met:
// `scm.mfg_sales_order_payments` (keyed by `so_doc_no`) and
// `scm.sales_invoice_payments` (keyed by `sales_invoice_id`). An order could be
// carrying a MYR 2,000 deposit while the invoice raised from it showed
// "No payments recorded yet" and an outstanding of the FULL invoice total, so
// the office chased money the customer had already handed over.
//
// WHY IT READS THROUGH INSTEAD OF COPYING ROWS. Copying the order's payment
// rows into `sales_invoice_payments` would post the same cash TWICE. Both
// ledgers are booked to the general ledger through the same rule —
// `acc/payments.ts` posts SOPAY for an order payment and SIPAY for an invoice
// payment, and both call `customerPaymentLines`, which is Dr cash/bank/transit
// and Cr AR (`acc/rules.ts`). A copied row would therefore debit cash a second
// time and relieve the same receivable twice, and `acc/daily-close.ts`'s
// `systemTakings` sums BOTH tables for one day's cash-up, so the drawer count
// would come up short by the whole deposit. Nothing is copied and nothing is
// posted here: this module only READS, and the invoice keeps carrying its own
// receipts in its own column.
//
// THE SPLIT RULE, when one order produced several invoices (owner, 2026-08-23):
// 「先扣第一张，扣完再溢到下一张」 — the earliest invoice absorbs what it can,
// then the remainder spills to the next. His worked example, an order holding
// 2,000 against invoices of 3,000 and 1,400: the first is left owing 1,000 and
// the second still owes its full 1,400. The property that makes it checkable is
// that the slices sum to the order's own collected total (or to what the
// invoices could absorb, whichever is smaller) — never more than either side.
// ----------------------------------------------------------------------------
import { soPaidInputsOf, soPaidSen } from '../shared/so-outstanding';

/** One invoice competing for the order's money. All sen. */
export interface AllocatableInvoice {
  id: string;
  /** `sales_invoices.invoice_number` — the tie-break, and unique per company. */
  invoiceNumber: string;
  /** `sales_invoices.invoice_date`, ISO date or null. Null sorts LAST. */
  invoiceDate: string | null;
  /** Raw `sales_invoices.status`. */
  status: string;
  totalSen: number;
  /** `sales_invoices.paid_sen` — receipts taken on THIS invoice, not the order. */
  ownPaidSen: number;
}

/* An invoice that cannot take money must not absorb any of the order's.
   CANCELLED is dead (the SI route refuses a payment on it, `not_payable`) and a
   DRAFT has posted no revenue and is refused the same way — letting either
   absorb a slice would hide that money from the invoice that can actually use
   it. The remaining statuses (SENT / PARTIALLY_PAID / PAID / OVERDUE) are all
   live documents; a PAID one simply has nothing left to absorb, which the
   outstanding term below handles on its own. */
const INELIGIBLE_STATUSES = new Set(['CANCELLED', 'DRAFT']);

export function absorbsOrderDeposit(status: string | null | undefined): boolean {
  return !INELIGIBLE_STATUSES.has((status ?? '').trim().toUpperCase());
}

/**
 * The allocation ORDER, and it is deliberately not `created_at`.
 *
 * `invoice_date` first because that is the date the office reads and the one
 * the owner's rule is phrased in ("第一张发票"), then `invoice_number` — which
 * is unique per company and monthly-minted zero-padded (`HC-SI-2608-004`), so
 * lexicographic order on the whole string is chronological across months too.
 * The pair is therefore a TOTAL order: no two rows can tie, so the same inputs
 * always produce the same slices. `created_at` was rejected because two
 * invoices converted from the same delivery in one action carry timestamps that
 * can genuinely be equal, which would leave the split up to row order.
 *
 * A null `invoice_date` sorts LAST so a dated invoice is never overtaken by an
 * undated one.
 */
export function sortForAllocation(rows: AllocatableInvoice[]): AllocatableInvoice[] {
  return [...rows].sort((a, b) => {
    const da = a.invoiceDate ?? '';
    const db = b.invoiceDate ?? '';
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    }
    return a.invoiceNumber < b.invoiceNumber ? -1 : a.invoiceNumber > b.invoiceNumber ? 1 : 0;
  });
}

/**
 * Split `orderCollectedSen` across the order's invoices, earliest first.
 *
 * Each eligible invoice absorbs `min(what is left, what it still owes)`, where
 * "what it still owes" is its own total less its own receipts. Money already
 * taken ON the invoice is therefore never displaced by the order's — the two
 * add up rather than competing.
 *
 * Guarantees, pinned by `si-order-deposit.test.ts`:
 *   · every slice is >= 0, and <= that invoice's own outstanding;
 *   · the slices sum to `min(orderCollectedSen, sum of eligible outstanding)`;
 *   · an ineligible invoice always gets 0.
 *
 * Everything is integer sen and every term is a subtraction of integers, so
 * there is no rounding to direct anywhere — the invariant test asserts that
 * rather than trusting it.
 */
export function allocateOrderDeposit(
  orderCollectedSen: number,
  invoices: AllocatableInvoice[],
): Map<string, number> {
  const out = new Map<string, number>();
  let remaining = Math.max(0, Math.trunc(Number.isFinite(orderCollectedSen) ? orderCollectedSen : 0));
  for (const inv of sortForAllocation(invoices)) {
    if (!absorbsOrderDeposit(inv.status)) { out.set(inv.id, 0); continue; }
    const outstanding = Math.max(0, Math.trunc(inv.totalSen) - Math.trunc(inv.ownPaidSen));
    const take = Math.min(remaining, outstanding);
    out.set(inv.id, take);
    remaining -= take;
  }
  return out;
}

/** One order payment, as the invoice screen shows it. */
export interface OrderDepositTransaction {
  id: string;
  paid_at: string | null;
  method: string | null;
  amount_sen: number;
  account_sheet: string | null;
  note: string | null;
}

export interface OrderDepositForInvoice {
  so_doc_no: string;
  /** Everything the ORDER has collected, by the SO's own rule (so-outstanding). */
  order_collected_sen: number;
  /** The slice of that allocated to the invoice this was read for. */
  applied_sen: number;
  /** The order's payment rows, so the screen can say WHICH document took it. */
  transactions: OrderDepositTransaction[];
}

type ReadResult =
  | { ok: true; deposit: OrderDepositForInvoice | null }
  | { ok: false; reason: string };

/* The columns the allocation needs off a sibling invoice. */
const SIBLING_COLS = 'id, invoice_number, invoice_date, status, total_sen, paid_sen';

/**
 * Gather everything the allocation needs for ONE order and run it.
 *
 * `companyId` is REQUIRED and not optional on purpose: `so_doc_no` proves a row
 * sits on that document, never that the document is in your books (CLAUDE.md,
 * company-scope rule (b)). Passing it as `null` is a decision — "no company
 * known" — and refuses rather than reading across the tenant boundary.
 *
 * Fails LOUD, never silently: any read error comes back `ok: false` so the
 * caller decides. Folding a failed read into "the order collected nothing"
 * would tell the office to chase money that is already in the drawer, which is
 * the exact bug this module exists to end.
 */
export async function readOrderDeposit(
  sb: any,
  soDocNo: string,
  companyId: number | null,
): Promise<{ ok: true; slices: Map<string, number>; collectedSen: number; transactions: OrderDepositTransaction[] } | { ok: false; reason: string }> {
  if (companyId == null) return { ok: false, reason: 'no active company' };

  const { data: soRow, error: soErr } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, company_id, total_revenue_sen, deposit_sen')
    .eq('doc_no', soDocNo)
    .eq('company_id', companyId)
    .maybeSingle();
  if (soErr) return { ok: false, reason: `order header: ${soErr.message}` };
  if (!soRow) return { ok: true, slices: new Map(), collectedSen: 0, transactions: [] };

  const [pays, sibs] = await Promise.all([
    sb.from('mfg_sales_order_payments')
      .select('id, paid_at, method, amount_sen, account_sheet, note, is_deposit')
      .eq('so_doc_no', soDocNo)
      .order('paid_at', { ascending: true }),
    sb.from('sales_invoices')
      .select(SIBLING_COLS)
      .eq('so_doc_no', soDocNo)
      .eq('company_id', companyId),
  ]);
  if (pays.error) return { ok: false, reason: `order payments: ${pays.error.message}` };
  if (sibs.error) return { ok: false, reason: `order invoices: ${sibs.error.message}` };

  const payRows = (pays.data ?? []) as Array<OrderDepositTransaction & { is_deposit?: boolean | null }>;
  const ledgerPaidSen = payRows.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0);
  const depositInLedger = payRows.some((p) => p.is_deposit === true);
  /* The SO's OWN rule for "what has this order collected", imported rather than
     re-derived. A second implementation of a money rule is how the order screen
     and the invoice screen start disagreeing quietly — the whole reason
     shared/so-outstanding.ts exists. It is also what carries the LEGACY header
     deposit (an order migrated from AutoCount whose deposit never became a
     ledger row), which a bare SUM over the payments table would miss. */
  const collectedSen = soPaidSen(
    soPaidInputsOf(soRow as Record<string, unknown>, ledgerPaidSen, depositInLedger),
  );

  const invoices: AllocatableInvoice[] = ((sibs.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number ?? ''),
    invoiceDate: (r.invoice_date as string | null) ?? null,
    status: String(r.status ?? ''),
    totalSen: Number(r.total_sen ?? 0),
    ownPaidSen: Number(r.paid_sen ?? 0),
  }));

  return {
    ok: true,
    slices: allocateOrderDeposit(collectedSen, invoices),
    collectedSen,
    transactions: payRows.map(({ is_deposit: _d, ...t }) => t),
  };
}

/**
 * What ONE invoice gets out of its order's deposit, ready for the screen.
 *
 * `null` (with `ok: true`) is the ordinary answer for a manual invoice with no
 * order behind it, or for an order that has collected nothing — there is no
 * panel to draw, not an error to report.
 */
export async function readOrderDepositForInvoice(
  sb: any,
  invoice: { id: string; so_doc_no?: string | null; company_id?: number | null },
): Promise<ReadResult> {
  const soDocNo = invoice.so_doc_no ?? null;
  if (!soDocNo) return { ok: true, deposit: null };
  const r = await readOrderDeposit(sb, soDocNo, invoice.company_id ?? null);
  if (!r.ok) return r;
  if (r.collectedSen <= 0) return { ok: true, deposit: null };
  return {
    ok: true,
    deposit: {
      so_doc_no: soDocNo,
      order_collected_sen: r.collectedSen,
      applied_sen: r.slices.get(invoice.id) ?? 0,
      transactions: r.transactions,
    },
  };
}

/** The persisted status an invoice should carry, given everything settling it. */
export function siStatusFor(current: string, totalSen: number, settledSen: number): string | null {
  /* LEAK GUARD (DRAFT) — never auto-advance a DRAFT invoice's status off the
     payments rollup. A DRAFT stays DRAFT until it is explicitly confirmed; the
     ladder below would otherwise silently flip it to SENT on a line edit.
     CANCELLED is likewise frozen. */
  if (current === 'CANCELLED' || current === 'DRAFT') return null;
  if (settledSen >= totalSen && totalSen > 0) return 'PAID';
  if (settledSen > 0) return 'PARTIALLY_PAID';
  return 'SENT';
}

/**
 * Roll the SI `paid_sen` + status from the persisted ledgers.
 *
 * Lifted out of `routes/sales-invoices.ts` (which is over its size ceiling and
 * may only shrink) so the ORDER-side writer can call it too — see
 * `recomputeSiPaidForOrder` below. Behaviour is unchanged apart from the status
 * ladder now counting the order's deposit.
 *
 * TWO NUMBERS, DELIBERATELY NOT ONE. `paid_sen` keeps meaning exactly what it
 * has always meant — receipts banked against THIS invoice — because the GL
 * posting, the AR-aging view (`scm.v_si_outstanding`) and the AutoCount
 * write-back all read it. The order's deposit is added only to the STATUS
 * decision, which is the thing the office reads to know whether to chase.
 *
 * Fails CLOSED and never throws — same contract as `recomputeTotals`.
 */
export async function recomputeSiPaid(sb: any, salesInvoiceId: string): Promise<void> {
  const { data: pays, error: paysErr } = await sb.from('sales_invoice_payments')
    .select('amount_sen').eq('sales_invoice_id', salesInvoiceId);
  /* A failed READ is not an unpaid invoice. `?? []` folded a transient blip into
     paid = 0, which does not merely understate paid_sen — it drives the status
     ladder below, so a fully PAID invoice silently reverted to SENT and re-entered
     the AR chase. An invoice that genuinely has no payments resolves error === null
     with data === [], and MUST still fall through to write paid = 0. */
  if (paysErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute-paid] payments read failed — paid/status left unchanged:', salesInvoiceId, paysErr.message);
    return;
  }
  const paid = (pays ?? []).reduce((s: number, p: { amount_sen: number }) => s + Number(p.amount_sen ?? 0), 0);
  const { data: cur, error: curErr } = await sb.from('sales_invoices')
    .select('total_sen, status, so_doc_no, company_id').eq('id', salesInvoiceId).maybeSingle();
  /* Distinct from `!cur` below: that is a genuinely missing invoice (error null,
     data null). This is "we could not find out", and the status ladder must not
     run on a total_sen we never read. */
  if (curErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute-paid] header read failed — paid/status left unchanged:', salesInvoiceId, curErr.message);
    return;
  }
  if (!cur) return;
  const c0 = cur as { total_sen: number; status: string; so_doc_no: string | null; company_id: number | null };

  /* The order's deposit counts as settled, so the STATUS the office reads
     agrees with the outstanding figure the screen shows. Same fail-closed
     contract as the two reads above and for the same reason: on a read error we
     do not know how much of this invoice is settled, and guessing 0 is the
     reversion-to-SENT incident recorded above wearing a different hat. So the
     paid_sen write (which we DID read) still lands, and the status is left
     exactly as it was for the next successful roll to fix. */
  let deposit = 0;
  let depositUnknown = false;
  if (c0.so_doc_no) {
    const d = await readOrderDeposit(sb, c0.so_doc_no, c0.company_id ?? null);
    if (d.ok) deposit = d.slices.get(salesInvoiceId) ?? 0;
    else {
      depositUnknown = true;
      /* eslint-disable-next-line no-console */
      console.error('[si-recompute-paid] order deposit read failed — status left unchanged:', salesInvoiceId, d.reason);
    }
  }

  const updates: Record<string, unknown> = { paid_sen: paid, updated_at: new Date().toISOString() };
  if (!depositUnknown) {
    const next = siStatusFor(c0.status, Number(c0.total_sen ?? 0), paid + deposit);
    if (next) {
      updates.status = next;
      if (next === 'PAID') updates.paid_at = new Date().toISOString();
    }
  }
  const { error: updErr } = await sb.from('sales_invoices').update(updates).eq('id', salesInvoiceId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute-paid] paid/status update failed — left STALE:', salesInvoiceId, updErr.message);
  }
}

/**
 * Re-roll every invoice raised off ONE order.
 *
 * Called from the ORDER's payment writer, because the deposit now decides an
 * invoice's status: without this the invoice screen would be right the moment
 * you opened it and the invoice LIST — which reads the persisted status — would
 * still say the customer owes everything until somebody happened to touch the
 * invoice. Best-effort and never throws, exactly like the AutoCount enqueue and
 * the GL posting it sits beside; a failure leaves stale status, which the next
 * roll self-heals.
 */
export async function recomputeSiPaidForOrder(sb: any, soDocNo: string, companyId: number | null): Promise<void> {
  if (!soDocNo || companyId == null) return;
  const { data, error } = await sb.from('sales_invoices')
    .select('id').eq('so_doc_no', soDocNo).eq('company_id', companyId);
  if (error) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute-paid] order fan-out read failed — invoice statuses left stale:', soDocNo, error.message);
    return;
  }
  for (const r of (data ?? []) as Array<{ id: string }>) {
    await recomputeSiPaid(sb, r.id);
  }
}

/**
 * Stamp `so_deposit_applied_sen` onto a PAGE of Sales Invoice list rows.
 *
 * WHY THE LIST NEEDS THIS AT ALL. The detail screen reading the deposit while
 * the LIST did not is worse than neither reading it: the two screens then
 * disagree about the same invoice, and the list is the one the office actually
 * scans to decide who to chase. Measured on production 2026-08-23 after the
 * detail-only fix shipped — detail 2,400, list 4,400, on `HC-SI-2608-004`.
 *
 * THE ROWS ON THE PAGE ARE NOT THE POPULATION. The split depends on the
 * SIBLING invoices of each order, and a sibling can sit on another page or be
 * filtered out of this one. So the sibling read is keyed by `so_doc_no`, not by
 * the page's ids, and the allocation is computed over the order's WHOLE set
 * before the page's rows take their slice out of it. A page-local allocation
 * would hand the same money to two different pages.
 *
 * THREE batched reads per page regardless of page size, in the style of
 * `stampSoDates` / `stampDoNumber` (routes/sales-invoices.ts) — the rule itself
 * is not reimplemented here, it is `allocateOrderDeposit` above, so the list and
 * the detail cannot drift apart.
 *
 * DEGRADATION IS DELIBERATE AND ONE-DIRECTIONAL. On a read failure the field is
 * stamped `null`, which every consumer reads as "no deposit known" and renders
 * the UN-adjusted, LARGER outstanding — today's behaviour, and the direction
 * that can only over-state what is owed. It is logged rather than swallowed,
 * which is more than the two stamps beside it do.
 */
export async function stampOrderDeposit(
  sb: any,
  rows: unknown,
  companyId: number | null,
): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const list = rows as Array<Record<string, unknown>>;
  for (const r of list) r.so_deposit_applied_sen = null;
  if (companyId == null) return;

  const soDocNos = [...new Set(
    list.map((r) => r.so_doc_no as string | null).filter((d): d is string => !!d),
  )];
  if (soDocNos.length === 0) {
    for (const r of list) r.so_deposit_applied_sen = 0;
    return;
  }

  const [sos, pays, sibs] = await Promise.all([
    sb.from('mfg_sales_orders')
      .select('doc_no, total_revenue_sen, deposit_sen')
      .in('doc_no', soDocNos).eq('company_id', companyId),
    sb.from('mfg_sales_order_payments')
      .select('so_doc_no, amount_sen, is_deposit').in('so_doc_no', soDocNos),
    sb.from('sales_invoices')
      .select(`so_doc_no, ${SIBLING_COLS}`)
      .in('so_doc_no', soDocNos).eq('company_id', companyId),
  ]);
  if (sos.error || pays.error || sibs.error) {
    /* eslint-disable-next-line no-console */
    console.error('[si-order-deposit] list stamp failed — rows keep the un-adjusted outstanding:',
      sos.error?.message ?? pays.error?.message ?? sibs.error?.message);
    return;
  }

  const ledgerByDoc = new Map<string, { sum: number; hasDeposit: boolean }>();
  for (const p of (pays.data ?? []) as Array<{ so_doc_no: string; amount_sen: number; is_deposit?: boolean | null }>) {
    const cur = ledgerByDoc.get(p.so_doc_no) ?? { sum: 0, hasDeposit: false };
    cur.sum += Number(p.amount_sen ?? 0);
    if (p.is_deposit === true) cur.hasDeposit = true;
    ledgerByDoc.set(p.so_doc_no, cur);
  }

  const invoicesByDoc = new Map<string, AllocatableInvoice[]>();
  for (const r of (sibs.data ?? []) as Array<Record<string, unknown>>) {
    const doc = (r.so_doc_no as string | null) ?? '';
    if (!doc) continue;
    const bucket = invoicesByDoc.get(doc) ?? [];
    bucket.push({
      id: String(r.id),
      invoiceNumber: String(r.invoice_number ?? ''),
      invoiceDate: (r.invoice_date as string | null) ?? null,
      status: String(r.status ?? ''),
      totalSen: Number(r.total_sen ?? 0),
      ownPaidSen: Number(r.paid_sen ?? 0),
    });
    invoicesByDoc.set(doc, bucket);
  }

  const applied = new Map<string, number>();
  for (const so of (sos.data ?? []) as Array<Record<string, unknown>>) {
    const doc = (so.doc_no as string | null) ?? '';
    if (!doc) continue;
    const led = ledgerByDoc.get(doc) ?? { sum: 0, hasDeposit: false };
    const collected = soPaidSen(soPaidInputsOf(so, led.sum, led.hasDeposit));
    for (const [id, take] of allocateOrderDeposit(collected, invoicesByDoc.get(doc) ?? [])) {
      applied.set(id, take);
    }
  }

  for (const r of list) {
    /* A row whose order is not in `sos` (no so_doc_no, or an order this company
       cannot see) resolves to 0 — it has no deposit to apply, which is a real
       answer, not a failed read. The failed-read case returned above with the
       field still null. */
    r.so_deposit_applied_sen = applied.get(String(r.id)) ?? 0;
  }
}
