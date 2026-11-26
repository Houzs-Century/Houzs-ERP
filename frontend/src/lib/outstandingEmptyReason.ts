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
  headerReadFailed?: boolean;
};

export type EmptyReasonInput = {
  isError: boolean;
  isLoading: boolean;
  scope: OutstandingScope | null;
  serverRowCount: number;
  scopedRowCount: number;
  poScopeActive: boolean;
  visibleRowCount: number;
  filtersActive: boolean;
};

const nameOf = (p: ScopedPo): string => p.poDocNo ?? 'the PO you came from';

const list = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

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

  if (isError) {
    return "We couldn't load the outstanding lines, so this list is incomplete. "
      + 'That is not the same as there being none left — please refresh and try again.';
  }
  if (isLoading) return 'Loading outstanding PO lines…';

  if (scope?.truncated) {
    return 'This list was cut short before it finished loading, so lines are missing from it. '
      + 'It does NOT mean there is nothing left to receive. Open a single Purchase Order '
      + 'and convert from there, which reads only that order.';
  }

  if (scope?.headerReadFailed) {
    return "We couldn't check the status of the Purchase Order you came from, so this "
      + 'list may be incomplete. That is not the same as its lines being received — '
      + 'please refresh and try again.';
  }

  if (scope && scope.unknownPoIds.length > 0 && scope.pos.length === 0) {
    return scope.unknownPoIds.length === 1
      ? 'That Purchase Order is not in this company\'s books, so none of its lines can be shown here. '
        + 'Check you are in the right company, or open the PO from the Purchase Orders list.'
      : `None of those ${scope.unknownPoIds.length} Purchase Orders are in this company's books. `
        + 'Check you are in the right company.';
  }

  if (scope && scope.pos.length > 0) {
    const blocked = scope.pos.filter((p) => !p.receivable);

    if (blocked.length === scope.pos.length && blocked.every(verifiedComplete) && serverRowCount === 0) {
      const parts = blocked.map((p) => `${nameOf(p)} is ${p.status ?? 'in an unknown status'}`);
      return `${list(parts)}, and every one of its lines has already been received in full. `
        + 'There is nothing left to put on a Goods Receipt.';
    }

    if (blocked.length === scope.pos.length) {
      const parts = blocked.map((p) => `${nameOf(p)} is ${p.status ?? 'in an unknown status'}`);
      return `${list(parts)}. Only a SUBMITTED or PARTIALLY_RECEIVED Purchase Order can be `
        + 'received against, so no lines are offered here. Submit the order first, or reopen it.';
    }

    const receivable = scope.pos.filter((p) => p.receivable);
    if (receivable.every(verifiedComplete) && serverRowCount === 0) {
      const parts = receivable.map((p) => nameOf(p));
      return `Every line on ${list(parts)} has already been received in full, so there is `
        + 'nothing left to put on a Goods Receipt.';
    }
  }

  if (serverRowCount > 0 && scopedRowCount === 0) {
    return `None of the ${serverRowCount} outstanding PO line(s) that loaded match the filters `
      + `on this screen. Clear the filters${poScopeActive ? ', or use "Show all POs" above,' : ''} `
      + 'to see them.';
  }

  if (serverRowCount > 0 && filtersActive) {
    return `${serverRowCount} outstanding line${serverRowCount === 1 ? '' : 's'} `
      + `${serverRowCount === 1 ? 'was' : 'were'} loaded, but the filters above hide `
      + `${serverRowCount === 1 ? 'it' : 'them all'}. Clear the category or date filter to see `
      + `${serverRowCount === 1 ? 'it' : 'them'}.`;
  }

  if (serverRowCount > 0) {
    return 'Every outstanding line is already on the Goods Receipt you are drafting, '
      + 'so there is nothing further to add. Go back and save it.';
  }

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
