// ----------------------------------------------------------------------------
// The deposit invoice's cost (owner 2026-11-26: 「记」, as AutoCount booked its
// deposit sales). A company with acc_company_settings.deposit_cost_pct books
// that share of each deposit invoice as cost on the invoice's own entry
// (Dr DEPOSIT_COST 619-0000 / Cr DEPOSIT_COST_ACCRUAL 410-0080; rules.ts
// depositInvoiceLines) and records it on the invoice (cost_sen). The note that
// takes the deposit back — the final invoice's close-out, a refund's, a move's,
// each naming the invoice as its source_doc_no — releases its share on its own
// entry (credit-notes.ts postCreditNote), so a deposit taken back in full has
// released exactly the cost it booked.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;

/** The share of a deposit the company books as cost, in percent, or null for none. */
export async function depositCostPct(
  sb: Db,
  companyId: number,
): Promise<{ ok: true; pct: number | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_company_settings')
    .select('deposit_cost_pct')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  const n = Number((data as { deposit_cost_pct?: unknown } | null)?.deposit_cost_pct);
  return { ok: true, pct: Number.isFinite(n) && n > 0 ? n : null };
}

/** A deposit's cost at that share, in whole sen; 0 when the company books none. */
export const depositCostSen = (amountSen: number, pct: number | null): number =>
  pct == null || !(amountSen > 0) ? 0 : Math.round((amountSen * pct) / 100);

/**
 * What one note releases of the cost its deposit invoice booked: the cost's
 * share of all that is taken back once this note stands, less its share
 * before it — so the notes on one invoice, however split, release exactly its
 * cost between them.
 */
export function depositCostReleaseSen(p: { costSen: number; amountSen: number; priorSen: number; thisSen: number }): number {
  if (!(p.costSen > 0) || !(p.amountSen > 0) || !(p.thisSen > 0)) return 0;
  const upTo = (taken: number): number => Math.round((p.costSen * Math.min(Math.max(taken, 0), p.amountSen)) / p.amountSen);
  return Math.max(0, upTo(p.priorSen + p.thisSen) - upTo(p.priorSen));
}

const DI_NUMBER = /-DI-\d{4}-\d+$/;

/**
 * The cost a credit note releases: nothing unless it names a live deposit
 * invoice of the company that booked one. The notes already posted against
 * the same invoice count first.
 */
export async function depositCostRelease(
  sb: Db,
  p: { companyId: number; noteId: string; sourceDocNo: string | null; thisSen: number },
): Promise<{ ok: true; sen: number } | { ok: false; reason: string }> {
  const diNumber = String(p.sourceDocNo ?? '').trim();
  if (!DI_NUMBER.test(diNumber)) return { ok: true, sen: 0 };
  const { data: di, error } = await sb.from('acc_deposit_invoices')
    .select('amount_sen, cost_sen')
    .eq('company_id', p.companyId)
    .eq('di_number', diNumber)
    .neq('status', 'CANCELLED')
    .maybeSingle();
  if (error) return { ok: false, reason: `deposit invoice ${diNumber}: ${error.message}` };
  const row = di as { amount_sen?: unknown; cost_sen?: unknown } | null;
  const costSen = Number(row?.cost_sen ?? 0);
  if (!row || !(costSen > 0)) return { ok: true, sen: 0 };
  const { data: others, error: oErr } = await sb.from('acc_credit_notes')
    .select('id, total_sen')
    .eq('company_id', p.companyId)
    .eq('kind', 'CN')
    .eq('source_doc_no', diNumber)
    .eq('status', 'POSTED');
  if (oErr) return { ok: false, reason: `notes on ${diNumber}: ${oErr.message}` };
  const priorSen = ((others ?? []) as Array<{ id: unknown; total_sen: unknown }>)
    .filter((o) => String(o.id) !== p.noteId)
    .reduce((t, o) => t + Number(o.total_sen ?? 0), 0);
  return { ok: true, sen: depositCostReleaseSen({ costSen, amountSen: Number(row.amount_sen), priorSen, thisSen: p.thisSen }) };
}
