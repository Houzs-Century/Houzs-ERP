/* The GRN-from-PO picker's empty state, which asserted a fact it could not know.
 *
 * Owner 2026-08-17: HC-PO-2608-001 showed two lines at Ordered 1 / Received 0 /
 * Balance 1 on the purchase order, and this screen answered `0 OF 0 ROWS` —
 * "No outstanding PO lines — every line has been received (or there are no
 * outstanding POs)." The server had returned nothing because its read was
 * truncated (GET /outstanding-po-items read an arbitrary 500-row sample of a
 * uuid ordering), and the copy reported that absence as a finished job.
 *
 * An empty result is only ever evidence that THE QUERY FOUND NOTHING. Three
 * states have to read differently, and the operator acts on the difference:
 * a failed read, a loaded set the on-screen filters hid, and an empty answer.
 * Only the middle one licenses a claim about what is left to do.
 *
 * These mount the REAL page under a real router at the real URL its caller
 * builds, with only the data hook faked, and assert what the operator SEES.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLink } from "../../lib/convertScope";

const { outstandingPoItems, grnDetail, addGrnItem } = vi.hoisted(() => ({
  outstandingPoItems: vi.fn(),
  grnDetail: vi.fn(),
  addGrnItem: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/suppliers-queries", () => ({
  useOutstandingPoItems: outstandingPoItems,
}));
vi.mock("../../vendor/scm/lib/grn-queries", () => ({
  useGrnDetail: grnDetail,
  useAddGrnItem: addGrnItem,
}));

import { GrnFromPo } from "./GrnFromPo";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const at = (url: string) =>
  render(<MemoryRouter initialEntries={[url]}><GrnFromPo /></MemoryRouter>);

/** The three states the page's own query hook can be in.
 *
 * `useOutstandingPoItems` returns the WHOLE endpoint payload — `{ items, scope }`
 * — not a bare array. `scope` is the block that lets an empty grid name its
 * cause, and it is optional on the wire (an older cached payload has none), so
 * these helpers cover both shapes: `loaded(rows)` is the no-scope payload and
 * `loadedWithScope(rows, scope)` is what the server sends today.
 */
const payload = (items: unknown[], scope?: unknown) => ({
  data: { items, ...(scope === undefined ? {} : { scope }) },
  isLoading: false,
  isError: false,
});
const loaded = (items: unknown[]) => payload(items);
const loadedWithScope = (items: unknown[], scope: unknown) => payload(items, scope);
const failed = { data: undefined, isLoading: false, isError: true };

/** A `scope` block as `GET /grns/outstanding-po-items` returns it. */
const scopeFor = (pos: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  requestedPoIds: pos.map((p) => p.poId),
  pos,
  unknownPoIds: [],
  truncated: false,
  headerReadFailed: false,
  scanned: 0,
  ...over,
});

const poLine = (over: Record<string, unknown> = {}) => ({
  poItemId: "poi-1", poId: "po-1", poDocNo: "HC-PO-2608-001",
  itemCode: "9028-1A(LHF)", supplierSku: null, description: "Sofa LHF",
  itemGroup: "sofa", qty: 1, receivedQty: 0, remainingQty: 1,
  unitPriceCenti: 0, warehouseId: "wh-1", variants: null, deliveryDate: null,
  supplierId: "sup-1", supplierCode: "400-H004", supplierName: "HOOKKA INDUSTRIES SDN. BHD.",
  poDate: "2026-08-17", expectedAt: "2026-08-29",
  warehouseLocationId: "wh-1", warehouseLocationCode: "KL", warehouseLocationName: "KL WAREHOUSE",
  ...over,
});

/* The page reads useGrnDetail only in append mode; every test here is the
   ordinary picker, so it stays idle. */
const noAppendTarget = () => {
  grnDetail.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  addGrnItem.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
};

describe("GRN-from-PO picker: an empty list never claims the work is done", () => {
  it("does not tell the operator every line was received when the query came back empty", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loaded([]));
    at(convertToLink("poToGrn", "po-1"));

    /* The exact sentence the owner was shown. Its problem is not tone: it
       asserts a state of the world from an absence of rows. */
    expect(screen.queryByText(/every line has been received/i)).toBeNull();
    expect(
      screen.getByText(/not the same as everything having been received/i),
    ).toBeTruthy();
  });

  it("names the company scope as a reason the lines could be missing", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loaded([]));
    at(convertToLink("poToGrn", "po-1"));

    /* The read is scoped to the active company and fails closed, so "nothing
       here" and "nothing visible from here" are indistinguishable on screen.
       The copy has to hand the operator that possibility, because it is the
       one they can act on. */
    expect(
      screen.getByText(/only covers the company you are working in/i),
    ).toBeTruthy();
  });

  it("still refuses to read as all-done when the read FAILED", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(failed);
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.getByText(/this list is incomplete/i)).toBeTruthy();
    expect(screen.queryByText(/every line has been received/i)).toBeNull();
  });

  it("blames the FILTERS, not the warehouse, when rows loaded but none are on this PO", () => {
    noAppendTarget();
    /* One line came back, and it belongs to a different purchase order than the
       one in the URL — so the page's own scope filter emptied the grid. That is
       the only empty state that knows anything, and it must say which of the
       two things happened rather than borrowing the all-done sentence. */
    outstandingPoItems.mockReturnValue(loaded([poLine({ poId: "po-2", poDocNo: "HC-PO-2608-002" })]));
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.getByText(/match the filters on this screen/i)).toBeTruthy();
    expect(screen.queryByText(/every line has been received/i)).toBeNull();
  });

  it("shows the line when it IS returned — the assertions above are not passing on an empty page", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loaded([poLine()]));
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.getAllByText("HC-PO-2608-001").length).toBeGreaterThan(0);
    expect(screen.queryByText(/every line has been received/i)).toBeNull();
    expect(screen.queryByText(/match the filters on this screen/i)).toBeNull();
  });
});

/* The payload the server actually sends now carries `scope`, so the page can name
   the ONE thing the copy above could only hedge about. These pin the two verdicts
   that matter — the status of a purchase order the picker will not open, and the
   only shape entitled to say the work is finished. */
describe("GRN-from-PO picker: the server's scope block names the cause", () => {
  it("names a DRAFT purchase order as a draft instead of hedging about the company", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loadedWithScope([], scopeFor([{
      poId: "po-1", poDocNo: "HC-PO-2608-001", status: "DRAFT",
      receivable: false, candidateLines: 0, outstandingLines: 0,
    }])));
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.getByText(/HC-PO-2608-001 is DRAFT/)).toBeTruthy();
    expect(screen.getByText(/Submit the order first/)).toBeTruthy();
    expect(screen.queryByText(/received in full/i)).toBeNull();
  });

  it("does NOT tell the operator to reopen a purchase order that is already fully received", () => {
    noAppendTarget();
    /* A RECEIVED purchase order reaches this screen with candidate rows counted
       and none outstanding — the read SAW its lines. "Reopen it" on a finished
       order invites a second receipt against lines already received in full. */
    outstandingPoItems.mockReturnValue(loadedWithScope([], scopeFor([{
      poId: "po-1", poDocNo: "HC-PO-2608-001", status: "RECEIVED",
      receivable: false, candidateLines: 2, outstandingLines: 0,
    }])));
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.getByText(/already been received in full/i)).toBeTruthy();
    expect(screen.queryByText(/reopen it/i)).toBeNull();
  });

  it("a truncated read says lines are MISSING, never that nothing is left", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loadedWithScope([], scopeFor([], { truncated: true })));
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.getByText(/cut short/i)).toBeTruthy();
    expect(screen.getByText(/does NOT mean there is nothing left to receive/)).toBeTruthy();
  });
});
