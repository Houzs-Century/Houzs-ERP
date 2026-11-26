/* ----------------------------------------------------------------------------
   The right-click menu on the OTHER five document lists — Purchase Invoice,
   Purchase Return, Delivery Return, Stock Transfer, Stock Take.

   The owner, 2026-08-22: 「为什么我的 Purchase Invoice 是没有的呢？」,
   「By right 每一个 Transaction Record 应该都可以右键（Right click）Move to
   Cancel，或者在 Draft 那边右键 Confirm 之类的。」 and 「只要有 Cancel / On Hold
   状态的，全部都可以右键 Cancel 或 On Hold。」

   WHAT THESE TESTS ARE ACTUALLY FOR. The menu's shape is the product here — the
   order of the groups, and which rows get which entry. Both are decided by
   plain predicates over a status string, which is exactly the kind of thing
   that reads correct and is wrong for one status. So the assertions are on the
   LABEL SEQUENCE for a named status, not on the internals.

   Two invariants are checked on all five together at the bottom, because they
   are the ones that would rot one list at a time: cancel is last, alone and
   red; and no menu offers a status a machine derives.
   ---------------------------------------------------------------------------- */

import { describe, expect, test, vi } from "vitest";
import type { RowMenuItem } from "../../lib/rowMenu";
import {
  purchaseInvoiceRowMenu,
  purchaseReturnRowMenu,
  deliveryReturnRowMenu,
  stockTransferRowMenu,
  stockTakeRowMenu,
} from "./row-menus";

type Row = {
  status?: string | null;
  id: string;
  invoice_number: string;
  return_number: string;
};
const labels = (m: RowMenuItem[]) => m.map((x) => (x.divider ? "—" : x.label));
const R = (o: { status?: string | null } = {}): Row =>
  ({ id: "row-id", invoice_number: "PI-0001", return_number: "PR-0001", ...o });
const noop = () => {};

/* THE GAP THIS PINS. When this menu was written the hold was still a STATUS
   being converted into a flag, so it carried the note "Hold follows" and no
   entry. Migration 0324 then mounted `PATCH /purchase-invoices/:id/hold` and the
   list kept its **On Hold tab** — a tab for a state nothing could reach, which
   is the exact fault #2661 removed from the PO and the GRN. Nobody came back.

   RED on the unfixed tree: neither entry was in the menu at all. */
describe("the purchase invoice can actually be held", () => {
  test("a live invoice is offered Put On Hold", () => {
    expect(labels(piMenu()(R({ status: "POSTED" })))).toContain("Put On Hold");
  });

  test("a held invoice is offered Take Off Hold, and not a second Put On Hold", () => {
    const held = { ...R({ status: "POSTED" }), on_hold: true } as Row;
    const l = labels(piMenu()(held));
    expect(l).toContain("Take Off Hold");
    expect(l).not.toContain("Put On Hold");
  });

  test("the two are never offered together", () => {
    for (const on_hold of [true, false]) {
      const l = labels(piMenu()({ ...R({ status: "POSTED" }), on_hold } as Row));
      expect(l.filter((x) => x === "Put On Hold" || x === "Take Off Hold")).toHaveLength(1);
    }
  });

  test("hold sits above Cancel — destructive stays last", () => {
    const l = labels(piMenu()(R({ status: "POSTED" })));
    expect(l.indexOf("Put On Hold")).toBeLessThan(l.indexOf("Cancel Purchase Invoice"));
  });

  test("the handler receives the row and the direction", () => {
    const seen: Array<[string, boolean]> = [];
    const m = piMenu({ setHold: (r, onHold) => seen.push([r.invoice_number, onHold]) })(R({ status: "POSTED" }));
    m.find((x) => x.label === "Put On Hold")!.onClick();
    expect(seen).toEqual([["PI-0001", true]]);
  });
});


const piMenu = (over: Partial<Parameters<typeof purchaseInvoiceRowMenu<Row>>[0]> = {}) =>
  purchaseInvoiceRowMenu<Row>({
    open: noop,
    edit: noop,
    copyAsNew: noop,
    print: noop,
    confirm: noop,
    setHold: noop,
    cancel: noop,
    canConfirm: (r) => (r.status ?? "").toUpperCase() === "DRAFT",
    canCancel: (r) => !["CANCELLED", "PAID"].includes((r.status ?? "").toUpperCase()),
    transferToPr: noop,
    canReturn: () => false,
    ...over,
  });

/* HC-0227 (Sim, AutoCount: right click a Purchase Invoice → Transfer to new
   Purchase Return). RED on the unfixed tree: the PI menu had no transfer group. */
describe("a purchase invoice can be returned from the menu", () => {
  test("the transfer sits in its own group, above Confirm", () => {
    expect(labels(piMenu({ canReturn: () => true })(R({ status: "DRAFT" })))).toEqual([
      "Open", "Edit", "Copy as new", "Print", "—", "Transfer to Purchase Return", "—", "Confirm",
      "—", "Put On Hold", "—", "Cancel Purchase Invoice",
    ]);
  });

  test("it hands the page the row it was opened on", () => {
    const transferToPr = vi.fn();
    const row = R({ status: "POSTED" });
    piMenu({ canReturn: () => true, transferToPr })(row)
      .find((i) => i.label === "Transfer to Purchase Return")!.onClick();
    expect(transferToPr).toHaveBeenCalledWith(row);
  });

  test("a row the page says cannot return gets no entry", () => {
    expect(labels(piMenu()(R({ status: "CANCELLED" })))).not.toContain("Transfer to Purchase Return");
  });
});

describe("purchaseInvoiceRowMenu", () => {
  test("a DRAFT offers Confirm, and Cancel below it", () => {
    expect(labels(piMenu()(R({ status: "DRAFT" })))).toEqual([
      "Open", "Edit", "Copy as new", "Print", "—", "Confirm", "—", "Put On Hold", "—", "Cancel Purchase Invoice",
    ]);
  });

  test("a confirmed invoice is not offered Confirm a second time", () => {
    expect(labels(piMenu()(R({ status: "POSTED" })))).toEqual([
      "Open", "Edit", "Copy as new", "Print", "—", "Put On Hold", "—", "Cancel Purchase Invoice",
    ]);
  });

  test("a PAID invoice cannot be cancelled from the menu", () => {
    expect(labels(piMenu()(R({ status: "PAID" })))).toEqual(["Open", "Edit", "Copy as new", "Print", "—", "Put On Hold"]);
  });

  test("a cancelled invoice is not offered a second cancel", () => {
    expect(labels(piMenu()(R({ status: "CANCELLED" })))).toEqual(["Open", "Edit", "Copy as new", "Print", "—", "Put On Hold"]);
  });

  test("Confirm calls the page's confirm handler with the row it was opened on", () => {
    const confirm = vi.fn();
    const row = R({ status: "DRAFT" });
    const item = piMenu({ confirm })(row).find((i) => i.label === "Confirm");
    item?.onClick();
    expect(confirm).toHaveBeenCalledWith(row);
  });
});


const prMenu = () =>
  purchaseReturnRowMenu<Row>({
    open: noop,
    edit: noop,
    print: noop,
    confirm: noop,
    cancel: noop,
    canConfirm: (r) => (r.status ?? "").toUpperCase() === "DRAFT",
    canCancel: (r) => !["COMPLETED", "CANCELLED"].includes((r.status ?? "").toUpperCase()),
  });

describe("purchaseReturnRowMenu", () => {
  test("a DRAFT offers Confirm and Cancel", () => {
    expect(labels(prMenu()(R({ status: "DRAFT" })))).toEqual([
      "Open", "Edit", "Print", "—", "Confirm", "—", "Cancel Purchase Return",
    ]);
  });

  test("a POSTED return can still be cancelled, which the drawer never showed", () => {
    expect(labels(prMenu()(R({ status: "POSTED" })))).toEqual([
      "Open", "Edit", "Print", "—", "Cancel Purchase Return",
    ]);
  });

  test("a COMPLETED return is terminal", () => {
    expect(labels(prMenu()(R({ status: "COMPLETED" })))).toEqual(["Open", "Edit", "Print"]);
  });
});


const drMenu = () =>
  deliveryReturnRowMenu<Row>({
    open: noop,
    edit: noop,
    print: noop,
    cancel: noop,
    canCancel: (r) => (r.status ?? "").toUpperCase() !== "CANCELLED",
  });

describe("deliveryReturnRowMenu", () => {
  test("a live return gets Open / Edit / Print and Cancel, and no Confirm", () => {
    expect(labels(drMenu()(R({ status: "RECEIVED" })))).toEqual([
      "Open", "Edit", "Print", "—", "Cancel Delivery Return",
    ]);
  });

  test("an inspected return is still cancellable", () => {
    expect(labels(drMenu()(R({ status: "INSPECTED" })))).toContain("Cancel Delivery Return");
  });

  test("a cancelled return is final", () => {
    expect(labels(drMenu()(R({ status: "CANCELLED" })))).toEqual(["Open", "Edit", "Print"]);
  });
});


const stMenu = () =>
  stockTransferRowMenu<Row>({
    open: noop,
    print: noop,
    cancel: noop,
    canCancel: (r) => (r.status ?? "").toUpperCase() === "POSTED",
  });

describe("stockTransferRowMenu", () => {
  test("Open, Print and Cancel", () => {
    expect(labels(stMenu()(R({ status: "POSTED" }))))
      .toEqual(["Open", "Print", "—", "Cancel Stock Transfer"]);
  });

  test("a cancelled transfer keeps Open and Print and loses Cancel, with no stray divider", () => {
    expect(labels(stMenu()(R({ status: "CANCELLED" })))).toEqual(["Open", "Print"]);
  });
});


const stkMenu = () =>
  stockTakeRowMenu<Row>({
    open: noop,
    print: noop,
    cancel: noop,
    canCancel: (r) => (r.status ?? "").toUpperCase() === "OPEN",
  });

describe("stockTakeRowMenu", () => {
  test("an OPEN take can be cancelled — it has written no movement yet", () => {
    expect(labels(stkMenu()(R({ status: "OPEN" }))))
      .toEqual(["Open", "Print", "—", "Cancel Stock Take"]);
  });

  test("a POSTED take is not offered Cancel", () => {
    expect(labels(stkMenu()(R({ status: "POSTED" })))).toEqual(["Open", "Print"]);
  });

  test("Print is offered on every status, cancelled included", () => {
    for (const status of ["OPEN", "POSTED", "CANCELLED"]) {
      expect(labels(stkMenu()(R({ status }))), status).toContain("Print");
    }
  });

  test("Confirm is not offered — posting needs the variance summary a row cannot show", () => {
    expect(labels(stkMenu()(R({ status: "OPEN" })))).not.toContain("Confirm");
  });

  /* Approve "from outside" (owner 2026-11-20): a supervisor signs off a pending
     count from the list. Offered only when the viewer may supervise AND the row
     is PENDING_APPROVAL. */
  const stkMenuSup = (sup: boolean) =>
    stockTakeRowMenu<Row>({
      open: noop, print: noop, cancel: noop,
      canCancel: (r) => (r.status ?? "").toUpperCase() === "OPEN",
      approve: noop, reject: noop,
      canApprove: (r) => sup && (r.status ?? "").toUpperCase() === "PENDING_APPROVAL",
    });

  test("a supervisor is offered Approve & Return on a PENDING take", () => {
    expect(labels(stkMenuSup(true)(R({ status: "PENDING_APPROVAL" }))))
      .toEqual(["Open", "Print", "—", "Approve & post", "Return to Open"]);
  });

  test("a non-supervisor is NOT offered Approve / Return on a PENDING take", () => {
    expect(labels(stkMenuSup(false)(R({ status: "PENDING_APPROVAL" }))))
      .toEqual(["Open", "Print"]);
  });

  test("Approve / Return are not offered on a non-pending take, even for a supervisor", () => {
    expect(labels(stkMenuSup(true)(R({ status: "POSTED" })))).toEqual(["Open", "Print"]);
    expect(labels(stkMenuSup(true)(R({ status: "OPEN" }))))
      .toEqual(["Open", "Print", "—", "Cancel Stock Take"]);
  });
});


const EVERY_MENU: ReadonlyArray<{ name: string; menu: (r: Row) => RowMenuItem[]; statuses: string[] }> = [
  { name: "Purchase Invoice", menu: piMenu(),  statuses: ["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"] },
  { name: "Purchase Return",  menu: prMenu(),  statuses: ["DRAFT", "POSTED", "COMPLETED", "CANCELLED"] },
  { name: "Delivery Return",  menu: drMenu(),  statuses: ["RECEIVED", "INSPECTED", "REFUNDED", "CREDIT_NOTED", "REJECTED", "CANCELLED"] },
  { name: "Stock Transfer",   menu: stMenu(),  statuses: ["POSTED", "CANCELLED"] },
  { name: "Stock Take",       menu: stkMenu(), statuses: ["OPEN", "POSTED", "CANCELLED"] },
];

describe("every one of the five menus, on every status that document has", () => {
  test("cancel is last, alone in its group, and red", () => {
    for (const { name, menu, statuses } of EVERY_MENU) {
      for (const status of statuses) {
        const items = menu(R({ status }));
        const cancels = items.filter((i) => i.label.startsWith("Cancel "));
        if (cancels.length === 0) continue;
        expect(cancels.length, `${name} / ${status}`).toBe(1);
        expect(items[items.length - 1]?.label, `${name} / ${status}`).toBe(cancels[0]!.label);
        expect(cancels[0]!.danger, `${name} / ${status}`).toBe(true);
        expect(items[items.length - 2]?.divider, `${name} / ${status}`).toBe(true);
      }
    }
  });

  test("no menu offers a status a machine derives, or a 'Mark X' entry", () => {
    const FORBIDDEN = /^(Mark |Set )|Inspected|Refunded|Credit note|Complete|Received|Shipped|Delivered|Ready to Ship/i;
    for (const { name, menu, statuses } of EVERY_MENU) {
      for (const status of statuses) {
        for (const item of menu(R({ status }))) {
          if (item.divider) continue;
          expect(item.label, `${name} / ${status}`).not.toMatch(FORBIDDEN);
        }
      }
    }
  });

  test("no menu is empty, starts with a divider, or ends with one", () => {
    for (const { name, menu, statuses } of EVERY_MENU) {
      for (const status of statuses) {
        const items = menu(R({ status }));
        expect(items.length, `${name} / ${status}`).toBeGreaterThan(0);
        expect(items[0]?.divider, `${name} / ${status}`).toBeFalsy();
        expect(items[items.length - 1]?.divider, `${name} / ${status}`).toBeFalsy();
      }
    }
  });

  test("every list offers Print, on every status that document has", () => {
    for (const { name, menu, statuses } of EVERY_MENU) {
      for (const status of statuses) {
        expect(labels(menu(R({ status }))), `${name} / ${status}`).toContain("Print");
      }
    }
  });

  test("an unrecognised or missing status still produces a usable menu", () => {
    for (const { name, menu } of EVERY_MENU) {
      for (const status of [null, undefined, "", "SOMETHING_NEW"]) {
        const items = menu(R({ status }));
        expect(items.length, `${name} / ${String(status)}`).toBeGreaterThan(0);
        expect(items[0]?.label, `${name} / ${String(status)}`).toBe("Open");
      }
    }
  });
});
