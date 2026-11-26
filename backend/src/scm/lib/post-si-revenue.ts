
import { todayMyt } from './my-time';
import { postJournal, reverseJournal } from '../../acc/engine';
import { resolveRoles, siLines, DEFAULT_ROLE_CODES } from '../../acc/rules';
import { splitByItemGroup } from '../../acc/item-group-split';
import { customerPartyCode } from '../../acc/payments';
import { applyDepositInvoicesBestEffort } from '../../acc/deposit-invoices';

export type PostSiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  | { ok: true; status: 'migrated_source' }
  /* The lines could not be classified (docs/bugs/0829): a line with no
     product group, or a group with no sales account bound for this company.
     The invoice stays unposted, by name; bind the group (Accounting → Item
     Groups) or fix the line, and the next create/confirm/resync posts it. */
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'no_lines' | 'line_ungrouped' | 'group_unbound' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'; reason?: string };

/**
 * Post (or no-op if already posted) the GL entry for a Sales Invoice.
 * Returns a structured result; never throws on the expected failure paths.
 */
export async function postSiRevenue(sb: any, invoiceNumber: string): Promise<PostSiResult> {
  const { data: si, error } = await sb
    .from('sales_invoices')
    .select('id, invoice_number, invoice_date, debtor_code, debtor_name, total_sen, company_id, migrated_no_stock, so_doc_no')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !si) return { ok: false, status: 'invoice_not_found' };

  if ((si as { migrated_no_stock?: boolean | null }).migrated_no_stock === true) {
    return { ok: true, status: 'migrated_source' };
  }
  const companyId = (si as { company_id?: number | null }).company_id ?? null;

  const totalSen = Number(si.total_sen);
  if (totalSen <= 0) return { ok: false, status: 'zero_total' };

  /* WHICH SALES ACCOUNT each ringgit belongs to (docs/bugs/0829, the mirror
     of the purchase side): the invoice's lines carry their product group, the
     registry carries the group's sales account, and the entry credits one
     line per group. A line with no group, or a group with no binding,
     REFUSES by name — the invoice is not booked on a guess. */
  const { data: itemsRaw, error: itemsErr } = await sb
    .from('sales_invoice_items')
    .select('item_group, line_total_sen')
    .eq('sales_invoice_id', (si as { id: string }).id);
  if (itemsErr) return { ok: false, status: 'post_failed', reason: `SI lines: ${itemsErr.message}` };
  const split = await splitByItemGroup(sb, {
    companyId,
    docNo: si.invoice_number,
    items: (itemsRaw ?? []) as Array<{ item_group: string | null; line_total_sen: number | null }>,
    account: 'sales_account',
    myrSen: (sen) => sen,
    totalSen,
  });
  if (!split.ok) return { ok: false, status: split.status, reason: split.reason };

  /* THE CUSTOMER'S CODE on the AR leg (docs/bugs/0830): the debtor code when
     the business keeps one (HOUZS), else the order's customer_id (2990 keeps
     no debtor codes) — the rule the payment, the deposit invoice and the
     credit note already follow, so the customer's sub-ledger nets across all
     four documents instead of the invoice sitting under no party. */
  let partyCode: string | null = customerPartyCode(si.debtor_code, null);
  const soDocNo = (si as { so_doc_no?: string | null }).so_doc_no ?? null;
  if (!partyCode && soDocNo) {
    const { data: so, error: soErr } = await sb.from('mfg_sales_orders')
      .select('customer_id, debtor_code').eq('doc_no', soDocNo).maybeSingle();
    if (soErr) return { ok: false, status: 'post_failed', reason: `order: ${soErr.message}` };
    const order = so as { customer_id?: string | null; debtor_code?: string | null } | null;
    partyCode = customerPartyCode(order?.debtor_code, order?.customer_id);
  }

  const roles = await resolveRoles(sb, companyId);
  const r = await postJournal(sb, {
    companyId,
    entryDate: si.invoice_date,
    sourceType: 'SI',
    sourceDocNo: si.invoice_number,
    narration: `Sales invoice ${si.invoice_number} — ${si.debtor_name}`,
    lines: siLines(roles, { invoice_number: si.invoice_number, debtor_code: partyCode, debtor_name: si.debtor_name }, split.groups),
  });

  if (r.ok) {
    /* THE DEPOSIT INVOICES CLOSE HERE (docs/bugs/0831): the revenue posting
       is the one gate every issued invoice passes (create, from-DO, confirm,
       resync, the backfill), so the credit note per deposit invoice is
       raised from it — once, idempotent, never blocking the posting. */
    await applyDepositInvoicesBestEffort(sb, {
      companyId, siId: (si as { id: string }).id, siNumber: si.invoice_number, soDocNo, invoiceDate: si.invoice_date, actor: null,
    });
    if (r.status === 'already_posted') return { ok: true, status: 'already_posted', jeNo: r.jeNo, jeId: r.jeId };
    return { ok: true, status: 'posted', jeNo: r.jeNo, jeId: r.jeId, totalSen };
  }
  if (r.status === 'idempotency_read_failed') {
    /* eslint-disable-next-line no-console */
    console.error('[si-revenue] idempotency read failed — SI NOT posted:', invoiceNumber, r.reason);
    return { ok: false, status: 'post_failed', reason: r.reason };
  }
  if (r.status === 'je_insert_failed' || r.status === 'lines_insert_failed' || r.status === 'post_failed') {
    return { ok: false, status: r.status, reason: r.reason };
  }
  return { ok: false, status: 'post_failed', reason: `${r.status}: ${r.reason ?? ''}` };
}

export type ReverseSiResult =
  | { ok: true; status: 'reversed'; jeNo: string; jeId: string }
  | { ok: true; status: 'already_reversed' | 'nothing_to_reverse' }
  | { ok: false; status: 'reversal_insert_failed' | 'reversal_lines_failed' | 'reversal_read_failed' | 'reversal_post_failed' | 'reversal_flag_failed'; reason?: string };

/**
 * Reverse (void) the revenue JE for a Sales Invoice when it is CANCELLED.
 *
 * A faithful contra through the engine: same accounts + parties, debit/credit
 * swapped, original flagged `reversed` + `reversed_by_je`. The balance views
 * (migration 0052) only count `posted = TRUE AND reversed = FALSE`, so the
 * pair nets to zero. Idempotent: keyed on the original's `reversed` flag AND
 * on the existence of a contra tied to it by `reversed_by_je`.
 */
export async function reverseSiRevenue(sb: any, invoiceNumber: string): Promise<ReverseSiResult> {
  return reverseJournal(sb, {
    sourceType: 'SI',
    sourceDocNo: invoiceNumber,
    narration: (orig) => `Reversal of ${orig.je_no} — Sales invoice ${invoiceNumber} cancelled`,
    entryDate: todayMyt(),
    fallbackLines: (totalSen) => [
      { accountCode: DEFAULT_ROLE_CODES.SALES, debitSen: totalSen, creditSen: 0, notes: `Reverse revenue ${invoiceNumber}` },
      { accountCode: DEFAULT_ROLE_CODES.AR, debitSen: 0, creditSen: totalSen, notes: `Reverse AR ${invoiceNumber}` },
    ],
  });
}

export type ResyncSiResult =
  | { ok: true; status: 'unchanged' | 'not_posted' | 'resynced' | 'reversed_to_zero' | 'posted' }
  | { ok: false; status: string; reason?: string };

/**
 * Re-align a Sales Invoice's revenue JE with its CURRENT total after a line was
 * edited / added / deleted post-issue. Wei Siang 2026-06-01 chose "auto void the
 * stale entry + re-post at the new amount" (auto credit-note + reissue) so the
 * GL never drifts from the invoice.
 *
 *   • No live JE yet + total > 0  → post a fresh one (covers a blank invoice
 *     getting its first line, and self-heals a never-posted issued invoice).
 *   • No live JE + total ≤ 0      → nothing to do.
 *   • Live JE, total unchanged    → no-op (no needless churn).
 *   • Live JE, total changed > 0  → void the stale JE, post a fresh one.
 *   • Live JE, new total ≤ 0      → void only (all lines gone → no revenue left).
 *
 * Idempotent: a second call finds the JE already matching → 'unchanged'.
 * Best-effort caller pattern — never blocks the line edit on a GL hiccup.
 */
export async function resyncSiRevenue(sb: any, invoiceNumber: string): Promise<ResyncSiResult> {
  const { data: jeRows, error: jeErr } = await sb
    .from('journal_entries')
    .select('id, total_debit_sen, reversed')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  if (jeErr) return { ok: false, status: 'resync_read_failed', reason: `jeRows: ${jeErr.message}` };
  const active = ((jeRows ?? []) as Array<{ id: string; total_debit_sen: number; reversed: boolean | null }>)
    .find((r) => !r.reversed);

  const { data: si, error: siErr } = await sb
    .from('sales_invoices')
    .select('total_sen, status')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  if (siErr) return { ok: false, status: 'resync_read_failed', reason: `si: ${siErr.message}` };
  const newTotal = Number((si as { total_sen?: number } | null)?.total_sen ?? 0);

  {
    const s = ((si as { status?: string } | null)?.status ?? '').toUpperCase();
    if (s === 'CANCELLED' || s === 'DRAFT') {
      return { ok: true, status: 'not_posted' };
    }
  }

  if (!active) {
    if (newTotal > 0) {
      const post = await postSiRevenue(sb, invoiceNumber);
      return post.ok ? { ok: true, status: 'posted' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
    }
    return { ok: true, status: 'not_posted' };
  }

  if (Number(active.total_debit_sen) === newTotal) return { ok: true, status: 'unchanged' };

  const rev = await reverseSiRevenue(sb, invoiceNumber);
  if (!rev.ok) return { ok: false, status: rev.status, reason: (rev as { reason?: string }).reason };

  if (newTotal <= 0) return { ok: true, status: 'reversed_to_zero' };
  const post = await postSiRevenue(sb, invoiceNumber);
  return post.ok ? { ok: true, status: 'resynced' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
}
