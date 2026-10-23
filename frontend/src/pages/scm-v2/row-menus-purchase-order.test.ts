/* HC-0149: the Purchase Order right-click menu offers Copy as new on every
   status, in the first group, and hands the ROW to its handler (the list builds
   `/scm/purchase-orders/new?copyFrom=<id>` from it). */

import { describe, expect, test, vi } from "vitest";
import type { RowMenuItem } from "../../lib/rowMenu";
import { purchaseOrderRowMenu } from "./row-menus";

type Row = { status?: string | null; id: string; po_number: string };
const labels = (m: RowMenuItem[]) => m.map((x) => (x.divider ? "—" : x.label));
const R = (status: string): Row => ({ id: "po-uuid-1", po_number: "HC-PO-2610-001", status });
const noop = () => {};

const poMenu = (over: Partial<Parameters<typeof purchaseOrderRowMenu<Row>>[0]> = {}) =>
  purchaseOrderRowMenu<Row>({
    open: noop, edit: noop, copyAsNew: noop, print: noop, transferToGrn: noop, setHold: noop, cancel: noop,
    canReceive: () => true, canCancel: () => true, isDraft: (r) => r.status === "DRAFT",
    ...over,
  });

describe("Copy as new", () => {
  test.each(["DRAFT", "SUBMITTED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"])("is offered on %s", (status) => {
    const l = labels(poMenu()(R(status)));
    expect(l.slice(0, l.indexOf("—"))).toEqual(["Open", "Edit", "Copy as new", "Print"]);
  });

  test("calls its handler with the row", () => {
    const copyAsNew = vi.fn();
    poMenu({ copyAsNew })(R("RECEIVED")).find((x) => x.label === "Copy as new")!.onClick();
    expect(copyAsNew).toHaveBeenCalledWith(expect.objectContaining({ id: "po-uuid-1" }));
  });
});
