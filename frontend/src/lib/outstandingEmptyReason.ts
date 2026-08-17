/* ----------------------------------------------------------------------------
 * outstandingEmptyReason — why the "Pick PO lines for this GRN" grid is empty.
 *
 * THE BUG (owner, 2026-08-17). He opened the picker scoped to one PO, the grid
 * returned zero rows, and the screen said:
 *
 *     "No outstanding PO lines — every line has been received (or there are no
 *      outstanding POs)."
 *
 * The PO had never been received. That one sentence covered FIVE different
 * situations, asserted the work was DONE in all of them, and hedged the
 * assertion with a parenthesis that covers only one of the other four. An
 * operator who believes it walks away from work that is still outstanding.
 *
 * The same shape had already been found twice the same week — the From-SO
 * picker's "every line has been converted" while MRP truncation hid the lines,
 * and MRP itself planning over 1,000 of 13,916 demand rows. So the rule this
 * module enforces is not about one sentence:
 *
 *     AN EMPTY RESULT MUST SAY WHY IT IS EMPTY, and must never claim a
 *     completion it has not verified.
 *
 * WHAT "VERIFIED" MEANS HERE, and it is narrower than it looks. The server read
 * is scoped to the active company and that scope FAILS CLOSED: when the company
 * context is resolved but no single active company can be picked, `scopeToCompany`
 * appends `.in('company_id', [])`, and PostgREST answers `[]` with `error: null`
 * (`backend/src/scm/lib/companyScope.ts`). A fail-closed read and a finished
 * company are byte-identical on the wire. So NO branch may turn an empty answer
 * into a claim about the world; the only completion claims allowed here are the
 * ones that name a document whose lines the server COUNTED and found at zero
 * (`candidateLines > 0 && outstandingLines === 0`).
 *
 * The facts come from the server (`GET /grns/outstanding-po-items` → `scope`),
 * because only the server knows the PO's status, whether this company holds it
 * at all, and whether its own paged read stopped early. The CLIENT-side reasons
 * — the screen's own PO scope / append lock, the toolbar filters and the
 * unsaved-draft subtraction — are passed in, one input each, so every branch
 * fails for exactly one reason.
 *
 * Shared by the desktop picker and the mobile convert wizard: one logic layer,
 * two presentations, per CLAUDE.md's desktop/mobile rule.
 * -------------------------------------------------------------------------- */

/** Mirror of the backend `ScopedPo` in `scm/lib/outstanding-po-lines.ts`. */
export type ScopedPo = {
  poId: string;
  poDocNo: string | null;
  status: string | null;
  receivable: boolean;
  candidateLines: number;
  outstandingLines: number;
};

/** Mirror of the backend `OutstandingScope`. */
export type OutstandingScope = {
  requestedPoIds: string[];
  pos: ScopedPo[];
  unknownPoIds: string[];
  truncated: boolean;
  scanned: number;
  /** The server's follow-up HEADER read failed, so a requested PO's absence from
   *  `pos` proves nothing about it. Optional because an older cached payload has
   *  no such field; absent is read as "did not fail", which is the same thing the
   *  previous version of this screen assumed and the only backwards-compatible
   *  reading. */
  headerReadFailed?: boolean;
};

export type EmptyReasonInput = {
  /** The read failed. Beats every other reason — an incomplete list must never
   *  read as an empty one. */
  isError: boolean;
  /** Still loading; the caller normally shows a spinner instead. */
  isLoading: boolean;
  /** The `scope` block the endpoint returned, or null on an older/failed read. */
  scope: OutstandingScope | null;
  /** Rows the server sent, BEFORE any client-side filtering. */
  serverRowCount: number;
  /** Rows left after the SCREEN's own narrowing — the `?poId=` scope and, in
   *  append mode, the one-supplier / one-warehouse lock — and before the toolbar
   *  filters and the unsaved-draft subtraction.
   *
   *  Its own input because it is its own cause. Folding it into `filtersActive`
   *  made a row the SCOPE dropped read as a row the operator's DRAFT had already
   *  taken ("go back and save it"), which sends them to the wrong screen. */
  scopedRowCount: number;
  /** Is the screen scoped to specific Purchase Orders (`?poId=`)? Decides whether
   *  the narrowing message may point at the "Show all POs" link, which the page
   *  renders only in that state — advice for a control that is not on screen is
   *  worse than none. */
  poScopeActive: boolean;
  /** Rows left after the toolbar filters + the unsaved-draft subtraction. */
  visibleRowCount: number;
  /** Is any toolbar filter (category / date range) currently narrowing? */
  filtersActive: boolean;
};

const nameOf = (p: ScopedPo): string => p.poDocNo ?? 'the PO you came from';

const list = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/**
 * Did the server COUNT this PO's lines and find none outstanding?
 *
 * The only evidence that licenses a completion claim, and it is deliberately not
 * "its status says RECEIVED": a status name is a second authority for a question
 * the counts already answer, and the frontend holding its own list of terminal
 * statuses is how the picker and the converter come to disagree. `candidateLines
 * > 0` is the load-bearing half — zero candidates means the read saw NOTHING for
 * this PO, which is the absence this whole module exists to stop dressing up as
 * a finished job.
 */
const verifiedComplete = (p: ScopedPo): boolean =>
  p.candidateLines > 0 && p.outstandingLines === 0;

/**
 * The sentence to show when `visibleRowCount === 0`.
 *
 * Returns null when there is nothing to explain (rows ARE visible), so a caller
 * can use it as the whole empty-state expression. The order of the branches is
 * the point: the most specific, most actionable truth wins, and the only
 * branches allowed to say "received in full" are the ones that counted.
 */
export function outstandingEmptyReason(input: EmptyReasonInput): string | null {
  const {
    isError, isLoading, scope, serverRowCount, scopedRowCount, visibleRowCount,
    filtersActive, poScopeActive,
  } = input;
  if (visibleRowCount > 0) return null;

  /* 1. A FAILED READ. "We could not load the lines" and "there are none left"
        are opposite facts, and the operator acts on the second one by walking
        away from work that is still outstanding. */
  if (isError) {
    return "We couldn't load the outstanding lines, so this list is incomplete. "
      + 'That is not the same as there being none left — please refresh and try again.';
  }
  if (isLoading) return 'Loading outstanding PO lines…';

  /* 2. THE READ STOPPED EARLY. This is the mechanism behind the owner's zero-row
        screen: the old code capped at 500 raw PO lines and filtered afterwards,
        so a PO outside the window was invisible with no signal at all. It is now
        paged, but a ceiling still exists and must announce itself rather than
        pass a short list off as a complete one. */
  if (scope?.truncated) {
    return 'This list was cut short before it finished loading, so lines are missing from it. '
      + 'It does NOT mean there is nothing left to receive. Open a single Purchase Order '
      + 'and convert from there, which reads only that order.';
  }

  /* 2b. THE STATUS LOOKUP FAILED. Everything below reasons about a PO's status,
         and the server could not read it — so "not in this company's books" and
         "is a draft" are both unproven. A blip must not become an accusation. */
  if (scope?.headerReadFailed) {
    return "We couldn't check the status of the Purchase Order you came from, so this "
      + 'list may be incomplete. That is not the same as its lines being received — '
      + 'please refresh and try again.';
  }

  /* 3. SCOPED TO POs THIS COMPANY DOES NOT HOLD. A wrong id, or another
        company's PO reached by a stale link. Silence here is how a
        cross-company link reads as "done". */
  if (scope && scope.unknownPoIds.length > 0 && scope.pos.length === 0) {
    return scope.unknownPoIds.length === 1
      ? 'That Purchase Order is not in this company\'s books, so none of its lines can be shown here. '
        + 'Check you are in the right company, or open the PO from the Purchase Orders list.'
      : `None of those ${scope.unknownPoIds.length} Purchase Orders are in this company's books. `
        + 'Check you are in the right company.';
  }

  if (scope && scope.pos.length > 0) {
    const blocked = scope.pos.filter((p) => !p.receivable);

    /* 4. SCOPED, THE STATUS EXCLUDES IT, AND THE READ SAW ITS LINES AT ZERO.
          A fully-received order is FINISHED, not obstructed. This branch used to
          be folded into branch 4b below, so a RECEIVED purchase order — which
          this endpoint now returns candidate rows for, because the SQL filter
          excludes only DRAFT and CANCELLED — was told "Submit the order first,
          or reopen it". Reopening a completed order invites a second receipt
          against lines already received in full, so the advice was worse than
          the wrong wording. */
    if (blocked.length === scope.pos.length && blocked.every(verifiedComplete) && serverRowCount === 0) {
      const parts = blocked.map((p) => `${nameOf(p)} is ${p.status ?? 'in an unknown status'}`);
      return `${list(parts)}, and every one of its lines has already been received in full. `
        + 'There is nothing left to put on a Goods Receipt.';
    }

    /* 4b. SCOPED, AND THE PO'S STATUS EXCLUDES IT WITH WORK STILL ON IT. A DRAFT
           is not yet an order and a CANCELLED one must not be received — both
           produce NO candidate rows, so the status arrives from the server's
           header read. A closed order that still counts outstanding lines lands
           here too, and for that one "reopen it" is the right advice. Naming the
           status is what lets the operator fix it in one step. */
    if (blocked.length === scope.pos.length) {
      const parts = blocked.map((p) => `${nameOf(p)} is ${p.status ?? 'in an unknown status'}`);
      return `${list(parts)}. Only a SUBMITTED or PARTIALLY_RECEIVED Purchase Order can be `
        + 'received against, so no lines are offered here. Submit the order first, or reopen it.';
    }

    /* 5. SCOPED, RECEIVABLE, AND GENUINELY FULLY RECEIVED. A completion claim
          about the NAMED document, on counts the server took.

          No `!filtersActive` condition, deliberately. The read is scoped to these
          POs, so `outstandingLines === 0` on all of them means the server sent
          nothing — `serverRowCount === 0` asserts exactly that, and a filter that
          hid nothing cannot be the cause. The old `!filtersActive` guard made a
          stale date filter push this case down to the UNSCOPED branch, where a
          one-PO read made a statement about the whole company. */
    const receivable = scope.pos.filter((p) => p.receivable);
    if (receivable.every(verifiedComplete) && serverRowCount === 0) {
      const parts = receivable.map((p) => nameOf(p));
      return `Every line on ${list(parts)} has already been received in full, so there is `
        + 'nothing left to put on a Goods Receipt.';
    }
  }

  /* 6. THIS SCREEN'S OWN NARROWING TOOK THEM. Rows arrived; the `?poId=` scope,
        or append mode's one-supplier / one-warehouse lock, is what emptied the
        grid. Nothing is finished and nothing is broken — and this is NOT the
        toolbar, so it must not be reported as the toolbar. */
  if (serverRowCount > 0 && scopedRowCount === 0) {
    return `None of the ${serverRowCount} outstanding PO line(s) that loaded match the filters `
      + `on this screen. Clear the filters${poScopeActive ? ', or use "Show all POs" above,' : ''} `
      + 'to see them.';
  }

  /* 7. THE TOOLBAR HID THEM. The server sent rows, they survived the scope, and
        a category or date filter removed them. */
  if (serverRowCount > 0 && filtersActive) {
    return `${serverRowCount} outstanding line${serverRowCount === 1 ? '' : 's'} `
      + `${serverRowCount === 1 ? 'was' : 'were'} loaded, but the filters above hide `
      + `${serverRowCount === 1 ? 'it' : 'them all'}. Clear the category or date filter to see `
      + `${serverRowCount === 1 ? 'it' : 'them'}.`;
  }

  /* 8. Rows arrived, survived the scope and the filters, and every one is
        already fully consumed by the UNSAVED draft the operator is building.
        Not "received" — spoken for, by them, a moment ago. */
  if (serverRowCount > 0) {
    return 'Every outstanding line is already on the Goods Receipt you are drafting, '
      + 'so there is nothing further to add. Go back and save it.';
  }

  /* 9. SCOPED, and nothing above could name a cause. Reached when the server
        returned no rows for a PO it DID find but could not count lines for
        (`candidateLines === 0` on a receivable order), or when scope and items
        disagree. It names the document and stops there: with no line count there
        is no verified completion, so there is no completion to claim. */
  if (scope && scope.requestedPoIds.length > 0 && scope.pos.length > 0) {
    const parts = scope.pos.map((p) => nameOf(p));
    return `This read found no outstanding lines on ${list(parts)}. That is not the same as `
      + 'everything having been received — open the purchase order and check its balance '
      + `before treating this as nothing left to receive.${filtersActive ? ' Clearing the filters above may also bring lines back.' : ''}`;
  }

  /* 10. UNSCOPED, and the server returned nothing.
         NOT A COMPLETION CLAIM, and this is the branch that used to be one. It
         said "every SUBMITTED and PARTIALLY_RECEIVED order has been received in
         full" — a statement about every purchase order in the company, made from
         an empty array that a fail-closed company scope produces identically
         (see the header). #2367 removed exactly this sentence from this screen;
         the wording below is the one it shipped. */
  return 'This search came back with no outstanding PO lines. That is not the same as '
    + 'everything having been received — the list only covers the company you are working in, '
    + 'and lines it cannot see look identical to lines that are done. Open the purchase order '
    + 'and check its balance before treating this as nothing left to receive.';
}
