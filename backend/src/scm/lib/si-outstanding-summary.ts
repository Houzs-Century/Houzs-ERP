// ----------------------------------------------------------------------------
// si-outstanding-summary — the SI module's figure on the Outstanding Dashboard,
// net of the deposits taken on the source Sales Orders.
//
// WHY IT IS NOT A SQL SUM LIKE THE OTHER SIX MODULES. `/outstanding/summary`
// pushes each module's total into PostgREST as one aggregate over its
// `v_*_outstanding` view. For SI that aggregate sums `outstanding_sen`, which
// the view defines as `total_sen - paid_sen` — blind to a deposit taken on the
// ORDER. Since #2684 the SI row list IS net of that deposit, so the dashboard
// card sat above a table it disagreed with, and the card was the bigger number:
// the one a person reads to decide how much is owed.
//
// The split of one order's deposit across its invoices depends on the invoice's
// SIBLINGS, so no SQL column and no aggregate can express it. The view is not an
// option either — recreating one is a NEW object with an empty ACL, which is how
// migration 0189 took the Sales Order list down for every user and needed 0190
// and 0191 to repair (CLAUDE.md, *Release discipline*). So the served FIGURE is
// adjusted, and nothing about the database changes.
//
// THE AGGREGATE IS THE FLOOR, THE SCAN ONLY REFINES IT DOWNWARD. The SQL number
// is computed first and kept. The row scan may then subtract deposits from it —
// and when the scan cannot finish, or cannot resolve some orders, the aggregate
// stands and the answer says so. The figure is therefore never smaller than the
// truth, only ever equal to it or too big, and it is never silently too big.
// ----------------------------------------------------------------------------
import { chunkSizeForUrl, PAGE } from './paginate-all';
import { stampOrderDeposit } from './si-order-deposit';
import { creditNotesBySi } from './si-credit-notes';

/**
 * How many outstanding invoices this will read before it stops trying.
 *
 * Sized in ROUND TRIPS, because that is the limit that bites on this platform:
 * Workers cap subrequests per request, and this repo has blown that cap twice
 * from per-line reads (the "subrequest diet" comments in
 * `mfg-pricing-recompute.ts` and `allowed-options-check.ts`, where ONE MRP load
 * already spends ~350). At this cap the SI module costs at most
 * `4 scan pages + 3 reads per batch of <=200 distinct orders` = **<=64
 * subrequests**, against a summary that spends 7 today.
 *
 * HOW MANY OUTSTANDING INVOICES A BUSY TENANT ACTUALLY HAS IS **UNKNOWN** here
 * and is deliberately not guessed. What is known without asking production:
 * `GET /outstanding/si` already pages through this same row set with no cap at
 * all, and the Outstanding page issues it the moment anyone opens the SI tab —
 * so this scan is not a new class of cost, it is the cost the page one click
 * later already pays. The number itself is one field on that response
 * (`rows.length`) and Finance can read it off the page.
 */
export const SI_SUMMARY_ROW_CAP = 4 * PAGE;

/** Only the columns the summary reduces over — narrower than the row list's
 *  `select('*')`, because nothing here renders. `so_doc_no` and `id` are what
 *  the deposit stamp keys on. */
export const SI_SUMMARY_COLS = 'id, so_doc_no, total_sen, outstanding_sen';

export interface SiSummaryEntry {
  count: number;
  total_sen: number;
  total_outstanding_sen: number;
  deposit_applied: boolean;
  deposit_note: string | null;
  unavailable?: true;
}

type Row = Record<string, unknown>;
type PageResult = { data: Row[] | null; error: { message: string } | null };

/**
 * The answer when nothing could be read.
 *
 * NOT a zeroed module, which is what every other module degrades to. On a page
 * about money owed, `0` reads as "nothing outstanding" — a lie in the one
 * direction that costs money, because it tells the office to stop chasing. This
 * shape makes the screen print a dash and say it could not read, which is the
 * honest answer and the one that gets someone to look.
 */
export function unavailableSiSummary(reason: string): SiSummaryEntry {
  return {
    count: 0,
    total_sen: 0,
    total_outstanding_sen: 0,
    deposit_applied: false,
    deposit_note: `The sales-invoice figures could not be read (${reason}).`,
    unavailable: true,
  };
}

/**
 * Subtract the order deposits from an SI outstanding total the SQL aggregate
 * already produced.
 *
 * `aggregate` is `null` when the aggregate itself failed — the scan then has to
 * supply the numbers on its own, and if it cannot, the caller gets
 * `unavailable`.
 *
 * `readPage` must return ONE page of the same filtered rows the aggregate
 * counted, selecting `SI_SUMMARY_COLS`.
 */
export async function summariseSiOutstanding(
  sb: any,
  readPage: (from: number, to: number) => PromiseLike<PageResult>,
  companyId: number | null,
  aggregate: { count: number; total_sen: number; total_outstanding_sen: number } | null,
): Promise<SiSummaryEntry> {
  const rows: Row[] = [];
  let complete = false;
  let scanError: string | null = null;

  for (let page = 0; page * PAGE < SI_SUMMARY_ROW_CAP; page++) {
    const from = page * PAGE;
    const { data, error } = await readPage(from, from + PAGE - 1);
    if (error) { scanError = error.message; break; }
    const got = data ?? [];
    rows.push(...got);
    if (got.length < PAGE) { complete = true; break; }
  }

  if (scanError !== null) {
    if (!aggregate) return unavailableSiSummary(scanError);
    return {
      ...aggregate,
      deposit_applied: false,
      deposit_note: 'Deposits taken on the sales orders could not be read, so this figure does not subtract them and may be too high.',
    };
  }

  if (!complete) {
    if (!aggregate) {
      return unavailableSiSummary(`more than ${SI_SUMMARY_ROW_CAP} outstanding invoices and no aggregate to fall back on`);
    }
    return {
      ...aggregate,
      deposit_applied: false,
      deposit_note: `More than ${SI_SUMMARY_ROW_CAP} outstanding invoices, so deposits taken on the sales orders are not subtracted here. The figure counts every invoice and may be too high. The SI tab below applies them per invoice.`,
    };
  }

  const docNos = [...new Set(rows.map((r) => (r.so_doc_no as string | null) ?? '').filter(Boolean))];
  const manual = rows.filter((r) => !r.so_doc_no);
  for (const r of manual) { r.so_deposit_applied_sen = 0; r.credit_notes_sen = null; }
  if (manual.length > 0 && companyId != null) {
    const credited = await creditNotesBySi(sb, companyId, manual.map((r) => String(r.id ?? '')));
    if (credited.ok) for (const r of manual) r.credit_notes_sen = credited.bySi.get(String(r.id)) ?? 0;
  }
  const batch = chunkSizeForUrl(docNos);
  let unresolved = 0;
  let creditsUnread = 0;
  if (docNos.length > 0) {
    for (let i = 0; i < docNos.length; i += batch) {
      const slice = new Set(docNos.slice(i, i + batch));
      const part = rows.filter((r) => slice.has((r.so_doc_no as string | null) ?? ''));
      await stampOrderDeposit(sb, part, companyId);
    }
  }

  let count = 0;
  let totalSen = 0;
  let outstandingSen = 0;
  for (const r of rows) {
    count += 1;
    totalSen += Number(r.total_sen ?? 0);
    const raw = Math.max(0, Number(r.outstanding_sen ?? 0));
    const dep = r.so_deposit_applied_sen;
    const cn = r.credit_notes_sen;
    if (cn === null || cn === undefined) creditsUnread += 1;
    const credit = cn === null || cn === undefined ? 0 : Math.max(0, Number(cn));
    if (dep === null || dep === undefined) { unresolved += 1; outstandingSen += Math.max(0, raw - credit); continue; }
    outstandingSen += Math.max(0, raw - Math.max(0, Number(dep)) - credit);
  }

  const notes = [
    unresolved === 0 ? null : `${unresolved} of ${count} invoices had a sales order that could not be read, so their deposits are not subtracted here and the figure may be too high.`,
    creditsUnread === 0 ? null : `The credit notes knocked off ${creditsUnread} of ${count} invoices could not be read, so they are not subtracted here and the figure may be too high.`,
  ].filter((t): t is string => t !== null);
  return {
    count,
    total_sen: totalSen,
    total_outstanding_sen: outstandingSen,
    deposit_applied: notes.length === 0,
    deposit_note: notes.length === 0 ? null : notes.join(' '),
  };
}
