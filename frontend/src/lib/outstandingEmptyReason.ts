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
 * The facts come from the server (`GET /grns/outstanding-po-items` → `scope`),
 * because only the server knows the PO's status, whether this company holds it
 * at all, and whether its own paged read stopped early. The CLIENT-side reasons
 * — the toolbar filters and the unsaved-draft subtraction — are passed in.
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
 * The sentence to show when `visibleRowCount === 0`.
 *
 * Returns null when there is nothing to explain (rows ARE visible), so a caller
 * can use it as the whole empty-state expression. The order of the branches is
 * the point: the most specific, most actionable truth wins, and the only branch
 * allowed to say "everything has been received" is the one that checked.
 */
export function outstandingEmptyReason(input: EmptyReasonInput): string | null {
  const { isError, isLoading, scope, serverRowCount, visibleRowCount, filtersActive } = input;
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

  /* 4. SCOPED, AND THE PO'S STATUS EXCLUDES IT. A DRAFT is not yet an order, a
        CANCELLED one must not be received, and a RECEIVED one is genuinely
        finished — three different facts, and only the third is "done". Naming
        the status is what lets the operator fix it in one step. */
  if (scope && scope.pos.length > 0) {
    const blocked = scope.pos.filter((p) => !p.receivable);
    if (blocked.length === scope.pos.length) {
      const parts = blocked.map((p) => `${nameOf(p)} is ${p.status ?? 'in an unknown status'}`);
      return `${list(parts)}. Only a SUBMITTED or PARTIALLY_RECEIVED Purchase Order can be `
        + 'received against, so no lines are offered here. Submit the order first, or reopen it.';
    }

    /* 5. SCOPED, RECEIVABLE, AND GENUINELY FULLY RECEIVED. The ONLY branch
          entitled to say the work is done — and it says it about the named
          document, not about the whole system. */
    const receivable = scope.pos.filter((p) => p.receivable);
    if (receivable.every((p) => p.outstandingLines === 0) && !filtersActive) {
      const parts = receivable.map((p) => nameOf(p));
      return `Every line on ${list(parts)} has already been received in full, so there is `
        + 'nothing left to put on a Goods Receipt.';
    }
  }

  /* 6. THE TOOLBAR HID THEM. The server sent rows; a category or date filter
        removed them. Nothing is finished and nothing is broken. */
  if (serverRowCount > 0 && filtersActive) {
    return `${serverRowCount} outstanding line${serverRowCount === 1 ? '' : 's'} `
      + `${serverRowCount === 1 ? 'was' : 'were'} loaded, but the filters above hide `
      + `${serverRowCount === 1 ? 'it' : 'them all'}. Clear the category or date filter to see `
      + `${serverRowCount === 1 ? 'it' : 'them'}.`;
  }

  /* 7. Rows arrived but every one is already fully consumed by the UNSAVED
        draft the operator is building. Not "received" — spoken for, by them,
        a moment ago. */
  if (serverRowCount > 0) {
    return 'Every outstanding line is already on the Goods Receipt you are drafting, '
      + 'so there is nothing further to add. Go back and save it.';
  }

  /* 8. UNSCOPED, and the server genuinely returned nothing. Still not a
        completion claim: it is a statement about what this read found. */
  return 'No Purchase Order lines are awaiting receipt in this company right now — '
    + 'every SUBMITTED and PARTIALLY_RECEIVED order has been received in full. '
    + 'A line only appears here once its order is submitted.';
}
