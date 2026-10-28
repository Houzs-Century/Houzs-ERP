/* ----------------------------------------------------------------------------
   use-close-action — the words shown before a Sales Order's remainder is given
   up on.

   CLOSE = STOP CHASING THE REMAINDER. The customer ordered 10 and took 7, or the
   supplier cannot supply the last 3. The document STAYS and everything already
   delivered and invoiced STANDS; only the outstanding part is abandoned. Asked
   whether that case happens here, the owner (2026-08-22): 「有的」.

   WHY THE COPY LIVES IN ITS OWN FILE, and it is the same reason `use-hold-action`
   does. **Close is one menu entry away from Cancel and the two do opposite
   things to the money** — Cancel voids the whole document as if it never
   happened and turns a deposit into customer credit; Close keeps a real sale
   that came up short. The only thing standing between them at the moment of the
   click is this sentence, so it is a decision, not boilerplate, and it does not
   belong inlined in a 2,300-line screen where a reword goes unreviewed.

   IT ALSO KEEPS THE LIST UNDER ITS SIZE CEILING. `MfgSalesOrdersListV2.tsx` sits
   on `scripts/file-size-ceilings.json` with single-digit headroom, and this
   repo's rule is that new code moves into a module rather than a ceiling moving
   up.

   THE CONFIRM SHAPE, not `window.confirm`: every other action on the Sales Order
   list runs through `askConfirm`, and `use-hold-action` records the same
   exception for the same screen.
   ---------------------------------------------------------------------------- */

/**
 * The confirm-dialog copy for `Close remaining`.
 *
 * THREE THINGS THE BODY MUST KEEP SAYING, in this order, because each one is a
 * question the person is actually asking at that moment:
 *   1. the order stays and what already went out still counts;
 *   2. what has not shipped stops being chased, and nothing more can be raised;
 *   3. this is NOT a cancellation.
 * The third sentence is the one that must never be dropped for brevity.
 */
export const closePrompt = (docNumber: string) => ({
  title: `Stop chasing the rest of ${docNumber}?`,
  body:
    "The order stays, and everything already delivered and invoiced still counts. "
    + "What has not shipped will no longer be chased, and no new delivery order or "
    + "purchase order can be raised from it. This is not a cancellation.",
  confirmLabel: "Close remaining",
});

/**
 * The whole Close-remaining action: confirm with the words above, then write the
 * status. Built as a factory rather than a hook so it stays a pure function of
 * its three dependencies and can be tested without rendering the 2,300-line
 * screen it is called from.
 *
 * `mutate` IS THE PAGE'S OWN status mutation, passed in rather than created
 * here: the page already holds it (`useUpdateMfgSalesOrderStatus`) and creating
 * a second one would give the two callers two caches to invalidate.
 *
 * `expectedStatus` is forwarded so the write keeps the list's optimistic-CAS
 * behaviour — closing an order somebody else has already moved must lose, not
 * silently overwrite.
 */
export function makeCloseAction(deps: {
  askConfirm: (o: { title: string; body: string; confirmLabel: string }) => Promise<boolean>;
  notify: (o: { title: string; body: string; tone: "error" }) => void;
  mutate: (
    /* `expectedStatus` is REQUIRED, matching the mutation's own signature. It is
       the optimistic-CAS term, so an omittable one would mean a caller that
       forgot it silently overwrote whatever the row had moved to — the repo's
       standing rule about a parameter that DECIDES something. */
    vars: { docNo: string; status: string; expectedStatus: string | null },
    opts: { onError: (e: unknown) => void },
  ) => void;
}) {
  return async (row: { doc_no: string; status?: string | null }): Promise<void> => {
    if (!(await deps.askConfirm(closePrompt(row.doc_no)))) return;
    deps.mutate({ docNo: row.doc_no, status: "CLOSED", expectedStatus: row.status ?? null }, {
      onError: (e) => deps.notify({
        title: "Not closed",
        body: e instanceof Error ? e.message : "Something went wrong.",
        tone: "error",
      }),
    });
  };
}
