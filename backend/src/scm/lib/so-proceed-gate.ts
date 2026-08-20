// ----------------------------------------------------------------------------
// so-proceed-gate — the DB reads the Processing-Date / Proceed gates need, and
// the refusals they produce.
//
// WHY A MODULE AND NOT THREE MORE FUNCTIONS IN mfg-sales-orders.ts. That router
// is ~11,900 lines and sits under a file-size ceiling that may only FALL
// (scripts/file-size-ceilings.json), so new code there is new code that has to
// go somewhere else. These three belong together anyway: each one turns a
// docNo into the FACTS a shared pure rule module then judges
// (shared/so-save-problems.ts), and none of them decides anything itself.
//
// `sb: any` is the PostgREST-shaped Supabase client, matching the routes that
// call these. Constraining it recursively makes TypeScript expand the whole
// generated schema and can hit TS2589 — the same reason scopeSoItemToDocument
// in the router keeps its parameter unconstrained.
// ----------------------------------------------------------------------------
import {
  collectProceedGateProblems,
  collectProcessingGateProblems,
  proceedGateUnmetBody,
  type SaveProblem,
} from '../shared/so-save-problems';
import { findColourKivLines, findIncompleteVariantLines } from './so-variant-check';

/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
export async function soDepositFacts(
  sb: any,
  docNo: string,
): Promise<{ paidSen: number; totalSen: number }> {
  const [{ data: totRow }, { data: pays }] = await Promise.all([
    sb.from('mfg_sales_orders').select('local_total_sen').eq('doc_no', docNo).maybeSingle(),
    sb.from('mfg_sales_order_payments').select('amount_sen').eq('so_doc_no', docNo),
  ]);
  return {
    totalSen: Number((totRow as { local_total_sen?: number } | null)?.local_total_sen ?? 0),
    paidSen: ((pays ?? []) as Array<{ amount_sen?: number | null }>)
      .reduce((s, p) => s + Number(p.amount_sen ?? 0), 0),
  };
}

/* NO CALLERS, as of 2026-08-18 — and left standing deliberately.
 *
 * Its two call sites were both in routes/mfg-sales-orders.ts: the /status
 * IN_PRODUCTION stamp block, and the header PATCH's `proceededAt` branch. Both
 * went with the second Processing-Date storage (see "RETIRING THE SECOND
 * STORAGE" in shared/so-processing-date.ts):
 *   · the /status branch ran only when the order ALREADY carried a Processing
 *     Date, i.e. it re-gated a state that had already passed the same gate —
 *     and inconsistently, since an order that also carried a Proceed stamp was
 *     not re-gated at all. The first proceed is the request that PUTS the date
 *     on, and that branch already runs soProcessingDateProblemsForDoc, which is
 *     a superset of this.
 *   · the header PATCH branch fired on a bare `proceededAt` timestamp, a key no
 *     client has ever sent; it cannot be reached at all now that the key is out
 *     of the PATCH map.
 *
 * NOT DELETED because this module and its per-condition refusal landed hours
 * earlier in #2383 and are the better statement of the rule — deleting a
 * freshly-shipped export to tidy a merge is how work gets silently undone. If
 * a future proceed path needs to refuse, this is what it should call. Whoever
 * concludes it will never have one should remove it on purpose, with the same
 * note applied to `meetsProceedGate`, which is now callerless for the same
 * reason (docs/modules/sales-order.md's "TWO enforcement sites" is one live
 * site and two orphans). */
export async function soProceedGateBlocked(
  sb: any,
  docNo: string,
  /* No `email` — the unified gate dropped it (owner 2026-07-31). Left OUT of
     this shape rather than accepted-and-ignored, so a caller cannot believe it
     still matters. */
  eff: {
    customerName?: string | null;
    address1?: string | null; postcode?: string | null; deliveryDate?: string | null;
  },
  /* Picks the deposit fraction (Houzs 30% / 2990 50%). Absent falls back to the
     looser 30% — see processingDateThresholdFor for why never the stricter. */
  companyCode?: string | null,
): Promise<ReturnType<typeof proceedGateUnmetBody> | null> {
  const { paidSen, totalSen } = await soDepositFacts(sb, docNo);
  /* NAMES WHICH CONDITIONS FAILED, and only those. This used to return one
     stored sentence reciting all five (customer name, address line 1, postcode,
     delivery date, deposit) no matter which one was actually unmet. On
     2026-08-17 the owner hit it on a ZERO-TOTAL order, read the word "deposit"
     and chased a money bug for a day — the deposit term had PASSED
     (meetsDepositGate is vacuously true at total <= 0), and the order was
     missing its postcode. `problems` is the aggregated contract the frontend
     already renders (parseSaveProblems, owner 2026-07-18); `error` is
     unchanged, so nothing matching on the code notices. */
  const problems = collectProceedGateProblems({
    hasCustomerName: !!eff.customerName?.trim(),
    hasAddress: !!eff.address1?.trim(),
    hasPostcode: !!eff.postcode?.trim(),
    hasDeliveryDate: !!eff.deliveryDate?.trim(),
    /* soDepositFacts reads the centi ledger, which is the unit these amounts
       are PRINTED in — see ProceedGateFacts on why the field names carry it. */
    paidSen,
    totalSen,
    companyCode,
  });
  /* Identical verdict to the old `meetsProceedGate(...)` call: that predicate is
     itself defined as "this list is empty" (order-rules.ts proceedGateFailures),
     so no order's outcome moves — only the words do. */
  return problems.length === 0 ? null : proceedGateUnmetBody(problems);
}

/* See "THE PAIR RULE" in shared/so-processing-date.ts. */
export async function soProcessingDateProblemsForDoc(
  sb: any,
  docNo: string,
  procDate: string,
  header: {
    customerName?: string | null;
    address1?: string | null; postcode?: string | null; deliveryDate?: string | null;
  },
): Promise<SaveProblem[]> {
  /* NO DEPOSIT READ — owner ruling 2026-08-20, 「以电脑为准 —— 两边都不查」. This
     used to `soDepositFacts(sb, docNo)` alongside the line read and hand the
     result to the collector, which no longer has a money condition to weigh.
     The `companyCode` parameter went with it: it existed only to pick the
     deposit fraction (Houzs 30% / 2990 50%), and dropping it from the SIGNATURE
     rather than ignoring it is what makes the compiler name every caller — an
     optional parameter here would have let a call site keep passing a company
     and believe it still decided something. */
  /* FAILS CLOSED: an unreadable line list is not an empty one. supabase-js does
     not throw, so `const { data }` with no `error` bound cannot tell "the query
     failed" from "there are no lines" — and the caller reads [] as "no variant
     problems" and releases the order to purchasing with its lines unchecked.
     That is the same shape as the cancel gate's unreadable-ledger rule
     (docs/modules/sales-order.md), and the audit that names it is
     `audit:swallowed-reads`.

     The read used to sit inside a `Promise.all` beside the deposit read, where
     it swallowed its error just as silently; removing the deposit half is what
     put it under the checker. Fixed here rather than reproduced. */
  const { data: liveItems, error: itemsError } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, variants, cancelled').eq('doc_no', docNo);
  if (itemsError) {
    return [{
      code: 'so_lines_unreadable',
      message: 'The order lines could not be read, so this Processing Date was not set. Try again in a moment.',
      field: 'Processing Date',
    }];
  }
  const lines = ((liveItems ?? []) as Array<{
    id: string; item_code: string; item_group: string;
    variants: Record<string, unknown> | null; cancelled: boolean;
  }>)
    .filter((it) => !it.cancelled)
    .map((it) => ({ id: it.id, itemCode: it.item_code, group: it.item_group, variants: it.variants }));
  return collectProcessingGateProblems({
    procDate,
    delivDate: String(header.deliveryDate ?? '').slice(0, 10) || null,
    todayMY: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
    /* No orig* dates: this helper only runs when the order has NO stored
       Processing Date, so the date is new and nothing can be grandfathered. */
    variantOffenders: findIncompleteVariantLines(lines),
    kivOffenders: findColourKivLines(lines),
    completeness: {
      hasCustomerName: !!header.customerName?.trim(),
      hasAddress: !!header.address1?.trim(),
      hasPostcode: !!header.postcode?.trim(),
    },
  });
}
