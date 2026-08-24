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

type Row = {
  status?: string | null;
  on_hold?: boolean | null;
  doc_no: string;
  do_refs?: Array<{ id: string; docNo: string }> | null;
  si_refs?: Array<{ id: string; docNo: string }> | null;
};
const labels = (m: RowMenuItem[]) => m.map((x) => (x.divider ? "—" : x.label));
/* Fills the doc_no every Sales Order row really has, so each test still says
   only what it is about. No `do_refs` / `si_refs`, so these rows offer exactly
   one print entry — `Print` — and the chain entries are pinned in
   printChain.test.ts against rows that DO carry them. */
const R = (o: { status?: string | null; on_hold?: boolean | null } = {}): Row =>
  ({ doc_no: "SO-0001", ...o });
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
      expect(labels(soMenu()(R({ status })))).toContain("Close remaining");
    },
  );

  /* A draft has no remainder to give up on, a cancelled order never happened,
     and an already-closed one has nothing left to decide. */
  test.each(["DRAFT", "CANCELLED", "CLOSED"])("is NOT offered on %s", (status) => {
    expect(labels(soMenu()(R({ status })))).not.toContain("Close remaining");
  });

  /* "Close" alone reads as "finish", and finishing is the opposite of what this
     does — a remainder is being ABANDONED. */
  test("is never labelled just 'Close'", () => {
    expect(labels(soMenu()(R({ status: "CONFIRMED" })))).not.toContain("Close");
  });

  test("calls its own handler, not a hand-written status write", () => {
    const close = vi.fn();
    const setStatus = vi.fn();
    const item = soMenu({ close, setStatus })(R({ status: "DELIVERED" }))
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
    expect(labels(soMenu()(R({ status: "CLOSED" }))).join("|")).not.toMatch(/Delivery Order/);
  });

  /* THE HOLD IS STILL OFFERED, and that is a decision rather than an oversight.
     Since mig 0324 a hold is a MARKER, not a status — `PATCH /:docNo/hold`
     never touches `status` and deliberately does not gate on it
     (document-hold-route.ts says so in its own header). So a closed order can
     be flagged "on hold" as a note to whoever reads the list, and taking the
     flag off restores nothing because nothing was overwritten. Blocking it here
     would re-couple the two things mig 0324 separated. */
  test("still offers the hold marker, which says nothing about the status", () => {
    expect(labels(soMenu()(R({ status: "CLOSED" })))).toContain("Put On Hold");
  });

  /* And the reverse: a HELD order may be closed. The hold marker is not read by
     salesOrderRowMenu's `live` predicate, and the status route never selects
     `on_hold`. Recorded in docs/modules/document-status-vocabulary.md §1b. */
  test("a held order is still offered Close remaining", () => {
    expect(labels(soMenu()(R({ status: "CONFIRMED", on_hold: true })))).toContain("Close remaining");
  });

  /* Cancel STAYS. An order that turns out to be void entirely is the cancel
     guards' question, not this menu's — and the transition table lets
     CLOSED > CANCELLED through for the same reason. */
  test("still offers Cancel, alone, last and red", () => {
    const m = soMenu()(R({ status: "CLOSED" }));
    const last = m[m.length - 1]!;
    expect(last.label).toBe("Cancel Sales Order");
    expect(last.danger).toBe(true);
    expect(m[m.length - 2]!.divider).toBe(true);
  });
});

/* ── PRINT THE CHAIN, FROM THE ROW (owner 2026-08-22) ───────────────────────
   「正常我们 print PDF 都是点进去 print 的吧。那我要在这边 right click，可以点
   print SalesOrder、print DO，这样的意思其实就是 print PDF」

   printChain.test.ts pins WHICH documents a row may print. This pins that they
   reach the MENU, in the first group, and that clicking one asks for THAT
   document rather than the row it was opened on — which is the whole difference
   between this and the navigation it replaces. */
describe("Print, for the whole chain", () => {
  const withChain = (over: Partial<Row> = {}): Row => ({
    doc_no: "HC-SO-2608-001",
    status: "CONFIRMED",
    do_refs: [
      { id: "do-uuid-1", docNo: "HC-DO-2608-003" },
      { id: "do-uuid-2", docNo: "HC-DO-2608-004" },
    ],
    si_refs: [{ id: "si-uuid-1", docNo: "HC-SI-2608-007" }],
    ...over,
  });

  test("every chain document is offered, in the first group, before the separator", () => {
    const items = labels(soMenu()(withChain()));
    expect(items.slice(0, items.indexOf("—"))).toEqual([
      "Open", "Edit", "Print",
      "Print Delivery Order HC-DO-2608-003",
      "Print Delivery Order HC-DO-2608-004",
      "Print Sales Invoice HC-SI-2608-007",
    ]);
  });

  test("clicking a chain entry asks for THAT document, not the row's own", () => {
    const print = vi.fn();
    const menu = soMenu({ print })(withChain());
    menu.find((i) => i.label === "Print Delivery Order HC-DO-2608-004")?.onClick();
    expect(print).toHaveBeenCalledWith({ doc: "do", docNo: "HC-DO-2608-004", key: "do-uuid-2" });
  });

  test("plain Print still asks for the row's own document, addressed by its number", () => {
    const print = vi.fn();
    soMenu({ print })(withChain()).find((i) => i.label === "Print")?.onClick();
    expect(print).toHaveBeenCalledWith({ doc: "so", docNo: "HC-SO-2608-001", key: "HC-SO-2608-001" });
  });

  /* An order with no delivery must not show a dead or greyed "Print Delivery
     Order" — the entry is not BUILT, so nothing renders and no separator moves. */
  test("an order with nothing downstream offers Print and nothing else", () => {
    const items = labels(soMenu()(withChain({ do_refs: [], si_refs: [] })));
    expect(items.slice(0, items.indexOf("—"))).toEqual(["Open", "Edit", "Print"]);
    expect(items.some((l) => l.startsWith("Print "))).toBe(false);
  });

  /* Every other group is unchanged by the print entries — the shape rule
     (open/edit/print, transfer, status, cancel) still holds. */
  test("the groups after Print are untouched", () => {
    const items = labels(soMenu()(withChain({ status: "DRAFT", do_refs: [], si_refs: [] })));
    expect(items).toEqual([
      "Open", "Edit", "Print", "—", "Confirm", "Put On Hold", "—", "Cancel Sales Order",
    ]);
  });
});
