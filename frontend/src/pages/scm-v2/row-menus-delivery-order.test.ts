/* The Delivery Order right-click menu must not offer a delivered row a move
   BACK. "Mark Loaded" / "Mark In Transit" on a DELIVERED row used to un-deliver
   it with no reason and no audit; the way back is "Undo delivered" on the
   detail page, and the server refuses the plain move (`use_revert`). */
import { describe, expect, test, vi } from "vitest";
import type { RowMenuItem } from "../../lib/rowMenu";
import { deliveryOrderRowMenu } from "./row-menus";

type Row = { status?: string | null; id: string; do_number: string; so_doc_no?: string | null };
const labels = (m: RowMenuItem[]) => m.map((x) => (x.divider ? "—" : x.label));

const menu = deliveryOrderRowMenu<Row>({
  open: vi.fn(), edit: vi.fn(), print: vi.fn(), transferToSi: vi.fn(), transferToDr: vi.fn(),
  confirm: vi.fn(), setStatus: vi.fn(), setHold: vi.fn(), cancel: vi.fn(),
  canInvoice: () => false, canReturn: () => false, canConfirm: () => false, canCancel: () => false,
  canSetStatus: () => true,
});
const at = (status: string) => labels(menu({ id: "d1", do_number: "DO-1", status }));
const MARKS = ["Mark Loaded", "Mark In Transit", "Mark Delivered"];

describe("DO row menu — no move back from Delivered", () => {
  test.each(["DELIVERED", "SIGNED", "INVOICED", "delivered"])("%s offers none of the status marks", (s) => {
    const l = at(s);
    for (const m of MARKS) expect(l).not.toContain(m);
  });

  test("a row on the road still gets its marks", () => {
    const l = at("DISPATCHED");
    expect(l).toContain("Mark In Transit");
    expect(l).toContain("Mark Delivered");
    expect(l).not.toContain("Mark Loaded");
  });
});
