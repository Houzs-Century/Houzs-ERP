/* ----------------------------------------------------------------------------
   coverage-state — "not loaded yet" is not an answer, and must never render as
   one.

   THE BUG THIS ENDS (owner, 2026-09-02, with two screenshots of the same PO
   drill-down seconds apart): the first showed every line tagged STOCK, the
   second showed the same lines carrying HC-SO-001162 · PENDING. Nothing had
   changed but a second query arriving.

     「这样很容易误导人，人家会以为是 stop，或者以为是 bug ... 如果 loading 的
      时候，它应该就 show "loading" 的 frontend，而不是 show 这种 frontend。
      这种东西是要全套系统彻底解决掉的」

   A drill-down runs TWO queries — the lines, and the coverage that says which
   order each line was bought for. The loading gate covered only the first, and
   the cells read the second as `x ?? []`, so "I do not know yet" was collapsed
   into "I know, and the answer is none" and rendered as STOCK — a confident
   claim that this is unassigned stock. Same collapse blanked the sales order's
   Incoming PO column (docs/bugs/0596 fixed the missing FETCH; the loading
   window survived it).

   THE RULE. Three states, never two:

     'ready'        the data is here, or there was none to fetch. Render the
                    answer, including the honest empty one.
     'loading'      in flight. Render PendingTag, never an answer.
     'unavailable'  the read failed. Say so — a failure and an empty result are
                    opposite facts (the same rule the backend applies in
                    scm/lib/venue-binding.ts and autocount-relink.ts).

   IT IS A REQUIRED PROP wherever it applies, deliberately. CLAUDE.md: a
   parameter that DECIDES is required, never optional — an optional one means
   every caller that says nothing keeps the old behaviour, with no compile
   error and no runtime signal, which is exactly how four drill-downs came to
   share this bug and four others did not.
   -------------------------------------------------------------------------- */

import type { ReactElement } from "react";

/** Whether the SECOND query a cell depends on has arrived. */
export type CoverageState = "ready" | "loading" | "unavailable";

/** Resolve a react-query pair into the three states, in the one place. */
export function coverageStateOf(q: {
  isLoading: boolean;
  isError?: boolean;
}): CoverageState {
  if (q.isLoading) return "loading";
  if (q.isError) return "unavailable";
  return "ready";
}

/* Deliberately the SAME weight and shape as StockTag, so a cell does not jump
   when the answer lands — but plainly indeterminate, and it says which half is
   still coming rather than "loading" on its own. */
export function PendingTag() {
  return (
    <span
      title="Still working out which order this line was bought for. The line itself is already correct; this column fills in a moment."
      className="animate-pulse rounded border border-dashed border-border-subtle bg-surface-dim px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
    >
      WORKING…
    </span>
  );
}

/* A failed read is NOT an empty result. It gets its own words so nobody reads
   a broken connection as "this line has no order". */
export function UnavailableTag() {
  return (
    <span
      title="This column could not be loaded. The line itself is correct — reopen the row or refresh to try again."
      className="rounded border border-dashed border-err/40 bg-surface-dim px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-err"
    >
      NOT LOADED
    </span>
  );
}

/** The one branch every dependent cell takes before it renders an answer. */
export function coveragePlaceholder(state: CoverageState): ReactElement | null {
  if (state === "loading") return <PendingTag />;
  if (state === "unavailable") return <UnavailableTag />;
  return null;
}
