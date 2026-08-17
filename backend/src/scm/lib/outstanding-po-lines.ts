// ----------------------------------------------------------------------------
// outstanding-po-lines — the read behind GET /grns/outstanding-po-items, and the
// REASON an empty answer is empty.
//
// THE BUG THIS EXISTS FOR (owner, 2026-08-17). He opened "Pick PO lines for this
// GRN" scoped to one PO (`?poId=`), the banner read "Reviewing this PO", the
// grid returned ZERO rows, and the screen said:
//
//     "No outstanding PO lines — every line has been received (or there are no
//      outstanding POs)."
//
// The PO had never been received. Three separate mechanisms could produce that
// screen, and the sentence asserted the one that was false:
//
//  1. `.limit(500)` sat on the RAW `purchase_order_items` select, and BOTH
//     filters — parent status, and `qty - received_qty > 0` — ran afterwards in
//     JavaScript. So the 500-row window was spent on every PO line in the
//     company, received or not, draft or not. The picker never saw "the first
//     500 outstanding lines"; it saw "however many of an arbitrary 500 lines
//     happened to be outstanding". Any PO outside that window was invisible,
//     with no signal of any kind.
//  2. The window was ordered by `purchase_order_id DESC`. That is a key order,
//     not a date order, so WHICH 500 lines you got was arbitrary rather than
//     "the newest".
//  3. `?poId=` was never sent to the server. The scope was applied in the
//     browser, to the already-truncated list, so scoping could only ever
//     NARROW the window — never recover a PO that fell outside it.
//
// This module fixes all three by construction: the status filter and the poId
// scope are pushed into SQL, so the window is spent only on candidate rows and a
// scoped read is bounded by one PO's line count. `qty - received_qty > 0` stays
// in JS because PostgREST cannot compare two columns — but the read is now paged
// rather than capped, so that filter no longer runs over a truncated set.
//
// AND it reports WHY. `explainOutstanding` returns the facts an empty grid needs
// in order to say something true: the requested POs with their statuses, the
// ones this company's books do not hold, and whether the paged read hit its
// ceiling. "Every line has been received" and "your PO is not in the window I
// looked at" are opposite facts, and the operator acts on the first one by
// walking away from work that is still outstanding.
// ----------------------------------------------------------------------------

/* THE RECEIVABLE STATUS SET IS NOT DECLARED HERE, ON PURPOSE.
 *
 * `routes/grns.ts` already owns it — `RECEIVABLE_PO_STATUSES` +
 * `isReceivablePoStatus`, whose comment calls itself "the SINGLE predicate the
 * GRN create paths share". A copy in this module would be a second authority for
 * the same question, which is the duplicated-list bug CLAUDE.md names; worse, it
 * would be the copy that decides what the PICKER shows while the original
 * decides what the CONVERTER accepts, so a drift between them would present a
 * line the server then refuses. `explainOutstanding` therefore takes the
 * predicate as a REQUIRED parameter and calls the caller's one.
 */

/**
 * The NARROWER, SQL-side status filter — DRAFT and CANCELLED only.
 *
 * Why it is not the complement of RECEIVABLE_PO_STATUSES. The only embedded-
 * resource status filter this repo has proven against production is
 * `.not('<alias>.status', 'in', <quoted list>)` (`mrp.ts:535`, same table, same
 * `po:purchase_orders!inner` embed, and its own header records that
 * so-delivery-sync.ts proved the quoting). An `.in()` on an embedded path would
 * be a NEW form, and there is no local database and no PostgREST in CI to prove
 * it on — so it would ship on reasoning alone, which is the thing CLAUDE.md
 * forbids. Copying the proven form and leaving the exact set to JS keeps the
 * behaviour byte-identical to today's while still doing the job that matters:
 * the paged read stops walking every draft and cancelled order in history.
 *
 * A NULL-status row is dropped by `not.in` (NULL never passes NOT IN). That is
 * not a behaviour change: the JS gate drops it too, since NULL is in neither
 * RECEIVABLE status.
 */
export const PO_DEAD_FOR_RECEIPT: readonly string[] = ['DRAFT', 'CANCELLED'];

/** PostgREST's quoted in-list form, copied from mrp.ts's `sqlNotInList`. */
export const poDeadForReceiptSql = (): string =>
  `(${PO_DEAD_FOR_RECEIPT.map((s) => `"${s}"`).join(',')})`;

/** Ceiling on the paged read. 20 pages of 1000 = 20,000 candidate lines, which
 *  is a bound on RUNAWAY, not a business limit: it is only reachable when a
 *  company holds that many lines on live POs, and when it IS reached the caller
 *  is told so rather than being handed a short list that looks complete. */
export const OUTSTANDING_PAGE = 1000;
export const OUTSTANDING_MAX_PAGES = 20;

type QueryError = { message: string; code?: string } | null;

/** What one page of a PostgREST read looks like, typed loosely on purpose.
 *
 *  `unknown[]` rather than `T[]`: supabase-js infers a to-ONE embed
 *  (`po:purchase_orders!inner (...)`) as an ARRAY, which is wrong at runtime and
 *  makes every hand-written row type structurally incompatible with the builder.
 *  The repo's existing answer is `as unknown as Row[]` at the use site; keeping
 *  the widening HERE means the cast happens once, inside a function whose job is
 *  the read, instead of at each caller. */
export type RawPage = PromiseLike<{ data: unknown[] | null; error: QueryError }>;

export type OutstandingPageResult<T> = { data: T[] | null; error: QueryError; truncated: boolean };

/**
 * Page a PostgREST query to exhaustion and SAY whether it stopped early.
 *
 * Not `paginateAll` — that helper returns `{ data, error }` and therefore cannot
 * distinguish "that is all of them" from "that is as many as I was willing to
 * read", which is exactly the distinction this endpoint got wrong. The loop is
 * otherwise the same shape, deliberately.
 */
export async function pageWithTruncation<T>(
  makeQuery: (from: number, to: number) => RawPage,
): Promise<OutstandingPageResult<T>> {
  const all: T[] = [];
  for (let page = 0; page < OUTSTANDING_MAX_PAGES; page++) {
    const from = page * OUTSTANDING_PAGE;
    const { data, error } = await makeQuery(from, from + OUTSTANDING_PAGE - 1);
    if (error) return { data: null, error, truncated: false };
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < OUTSTANDING_PAGE) return { data: all, error: null, truncated: false };
  }
  // Every page came back full, so there is at least one more row we did not read.
  return { data: all, error: null, truncated: true };
}

/** `?poId=a,b,c` → `['a','b','c']`. Empty means the full, unscoped picker, which
 *  is a legitimate entry point (the list toolbar's "From PO"), not a broken link
 *  — see `frontend/src/lib/convertScope.tsx`. */
export function parsePoIdScope(raw: string | undefined | null): string[] {
  return [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/** What the server found for one PO the operator asked to receive. */
export type ScopedPo = {
  poId: string;
  poDocNo: string | null;
  status: string | null;
  /** Is this status one the picker will show lines from at all? */
  receivable: boolean;
  /** Lines on this PO that the status filter let through. */
  candidateLines: number;
  /** Of those, how many still have qty − received_qty > 0. */
  outstandingLines: number;
};

/**
 * The facts an empty grid needs. Returned as DATA, not as a sentence: the
 * desktop picker and the mobile convert wizard read the same endpoint, so the
 * wording belongs to each surface and the truth belongs here.
 */
export type OutstandingScope = {
  /** The ids the caller asked to be scoped to, after parsing. */
  requestedPoIds: string[];
  /** One entry per requested id THIS COMPANY HOLDS, in request order. */
  pos: ScopedPo[];
  /** Requested ids with no PO in this company's books — a wrong id, or another
   *  company's PO. Silence here is how a cross-company link reads as "done". */
  unknownPoIds: string[];
  /** The paged read stopped at its ceiling, so lines are missing from `items`. */
  truncated: boolean;
  /** Candidate lines actually read (post status filter, pre remaining filter). */
  scanned: number;
};

/** Minimal row shape this module reasons about. The route's Row type is wider. */
export type CountableRow = {
  purchase_order_id: string;
  qty: number;
  received_qty: number | null;
  po: { po_number?: string | null; status?: string | null } | null;
};

/** qty − received_qty, floored at nothing (a negative means over-receipt, which
 *  is not outstanding). Kept here so the route and the tests share one rule. */
export const remainingOf = (r: { qty: number; received_qty: number | null }): number =>
  r.qty - (r.received_qty ?? 0);

/**
 * Build the scope report from the rows the SQL returned.
 *
 * `headerStatuses` covers the requested POs that produced NO candidate rows —
 * a DRAFT or CANCELLED PO is filtered out in SQL, so its status can only be
 * learned from a separate header read. Pass an empty map when nothing was
 * requested; `null` is not accepted because "I did not look" and "I looked and
 * found nothing" are the two answers this whole module exists to separate.
 *
 * `isReceivable` is REQUIRED, per CLAUDE.md's rule about a parameter that
 * decides something: it decides whether the operator is told "your PO is a
 * draft" or "every line has been received", and those are opposite facts. It
 * must be the CALLER's predicate — see the note at the top of this file.
 */
export function explainOutstanding(
  requestedPoIds: string[],
  rows: CountableRow[],
  headerStatuses: Map<string, { poDocNo: string | null; status: string | null }>,
  truncated: boolean,
  isReceivable: (status: string | null | undefined) => boolean,
): OutstandingScope {
  const byPo = new Map<string, { docNo: string | null; status: string | null; candidate: number; outstanding: number }>();
  for (const r of rows) {
    const e = byPo.get(r.purchase_order_id) ?? {
      docNo: r.po?.po_number ?? null, status: r.po?.status ?? null, candidate: 0, outstanding: 0,
    };
    e.candidate += 1;
    if (remainingOf(r) > 0) e.outstanding += 1;
    byPo.set(r.purchase_order_id, e);
  }

  const pos: ScopedPo[] = [];
  const unknownPoIds: string[] = [];
  for (const id of requestedPoIds) {
    const seen = byPo.get(id);
    const header = headerStatuses.get(id);
    if (!seen && !header) { unknownPoIds.push(id); continue; }
    const status = seen?.status ?? header?.status ?? null;
    pos.push({
      poId: id,
      poDocNo: seen?.docNo ?? header?.poDocNo ?? null,
      status,
      receivable: isReceivable(status),
      candidateLines: seen?.candidate ?? 0,
      outstandingLines: seen?.outstanding ?? 0,
    });
  }

  return { requestedPoIds, pos, unknownPoIds, truncated, scanned: rows.length };
}
