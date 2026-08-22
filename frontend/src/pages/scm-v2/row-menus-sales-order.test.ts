/* ----------------------------------------------------------------------------
   The Sales Order right-click menu — the four decisions a person may make, and
   the two that must never be confused with each other.

   WHAT THIS IS FOR. The menu's shape is the product: which rows get which entry,
   and what the entry is CALLED. Both are decided by plain predicates over a
   status string, which is exactly the kind of thing that reads correct and is
   wrong for one status. So the assertions are on the LABEL SEQUENCE for a named
   status, the same shape as row-menus-remaining-lists.test.ts.

   CLOSE AND CANCEL ARE ONE MENU APART AND DO OPPOSITE THINGS TO THE MONEY —
   Close keeps the document and everything already delivered against it, Cancel
   voids the whole thing and turns a deposit into customer credit. The label is
   what stands between them, so the label is pinned.
   ---------------------------------------------------------------------------- */

import { describe, expect, test, vi } from "vitest";
import type { RowMenuItem } from "../../lib/rowMenu";
import { salesOrderRowMenu } from "./row-menus";

type Row = { status?: string | null; on_hold?: boolean | null };
const labels = (m: RowMenuItem[]) => m.map((x) => (x.divider ? "—" : x.label));
const noop = () => {};

const soMenu = (over: Partial<Parameters<typeof salesOrderRowMenu<Row>>[0]> = {}) =>
  salesOrderRowMenu<Row>({
    open: noop, edit: noop, print: noop, confirm: noop, transferToDo: noop,
    setStatus: noop, close: noop, setHold: noop, cancel: noop, reopen: noop, canDeliver: true,
    ...over,
  });

describe("Close remaining", () => {
  test.each(["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "DELIVERED", "INVOICED", "ON_HOLD"])(
    "is offered on a live order (%s)",
    (status) => {
      expect(labels(soMenu()({ status }))).toContain("Close remaining");
    },
  );

  /* A draft has no remainder to give up on, a cancelled order never happened,
     and an already-closed one has nothing left to decide. */
  test.each(["DRAFT", "CANCELLED", "CLOSED"])("is NOT offered on %s", (status) => {
    expect(labels(soMenu()({ status }))).not.toContain("Close remaining");
  });

  /* "Close" alone reads as "finish", and finishing is the opposite of what this
     does — a remainder is being ABANDONED. */
  test("is never labelled just 'Close'", () => {
    expect(labels(soMenu()({ status: "CONFIRMED" }))).not.toContain("Close");
  });

  test("calls its own handler, not a hand-written status write", () => {
    const close = vi.fn();
    const setStatus = vi.fn();
    const item = soMenu({ close, setStatus })({ status: "DELIVERED" })
      .find((i) => i.label === "Close remaining");
    item!.onClick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("a closed order is terminal on this menu", () => {
  /* Closing says the remainder is not coming, so there is nothing left to
     deliver — soCanRaiseDo names CLOSED in the deny-list and the entry goes. */
  test("offers no Transfer to Delivery Order", () => {
    expect(labels(soMenu()({ status: "CLOSED" })).join("|")).not.toMatch(/Delivery Order/);
  });

  /* THE HOLD IS STILL OFFERED, and that is a decision rather than an oversight.
     Since mig 0324 a hold is a MARKER, not a status — `PATCH /:docNo/hold`
     never touches `status` and deliberately does not gate on it
     (document-hold-route.ts says so in its own header). So a closed order can
     be flagged "on hold" as a note to whoever reads the list, and taking the
     flag off restores nothing because nothing was overwritten. Blocking it here
     would re-couple the two things mig 0324 separated. */
  test("still offers the hold marker, which says nothing about the status", () => {
    expect(labels(soMenu()({ status: "CLOSED" }))).toContain("Put On Hold");
  });

  /* And the reverse: a HELD order may be closed. The hold marker is not read by
     salesOrderRowMenu's `live` predicate, and the status route never selects
     `on_hold`. Recorded in docs/modules/document-status-vocabulary.md §1b. */
  test("a held order is still offered Close remaining", () => {
    expect(labels(soMenu()({ status: "CONFIRMED", on_hold: true }))).toContain("Close remaining");
  });

  /* Cancel STAYS. An order that turns out to be void entirely is the cancel
     guards' question, not this menu's — and the transition table lets
     CLOSED > CANCELLED through for the same reason. */
  test("still offers Cancel, alone, last and red", () => {
    const m = soMenu()({ status: "CLOSED" });
    const last = m[m.length - 1]!;
    expect(last.label).toBe("Cancel Sales Order");
    expect(last.danger).toBe(true);
    expect(m[m.length - 2]!.divider).toBe(true);
  });
});
