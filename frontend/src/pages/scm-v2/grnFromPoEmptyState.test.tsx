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

const payload = (items: unknown[], scope?: unknown) => ({
  data: { items, ...(scope === undefined ? {} : { scope }) },
  isLoading: false,
  isError: false,
});
const loaded = (items: unknown[]) => payload(items);
const loadedWithScope = (items: unknown[], scope: unknown) => payload(items, scope);
const failed = { data: undefined, isLoading: false, isError: true };

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
  unitPriceSen: 0, warehouseId: "wh-1", variants: null, deliveryDate: null,
  supplierId: "sup-1", supplierCode: "400-H004", supplierName: "HOOKKA INDUSTRIES SDN. BHD.",
  poDate: "2026-08-17", expectedAt: "2026-08-29",
  warehouseLocationId: "wh-1", warehouseLocationCode: "KL", warehouseLocationName: "KL WAREHOUSE",
  ...over,
});

const noAppendTarget = () => {
  grnDetail.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  addGrnItem.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
};

describe("GRN-from-PO picker: an empty list never claims the work is done", () => {
  it("does not tell the operator every line was received when the query came back empty", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loaded([]));
    at(convertToLink("poToGrn", "po-1"));

    expect(screen.queryByText(/every line has been received/i)).toBeNull();
    expect(
      screen.getByText(/not the same as everything having been received/i),
    ).toBeTruthy();
  });

  it("names the company scope as a reason the lines could be missing", () => {
    noAppendTarget();
    outstandingPoItems.mockReturnValue(loaded([]));
    at(convertToLink("poToGrn", "po-1"));

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

describe("GRN-from-PO append: a partial failure is not added twice", () => {
  it("unticks the lines that landed, so pressing again appends only the rest", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const mutateAsync = vi.fn()
      .mockResolvedValueOnce({ item: { id: "gi-1" } })
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue({ item: { id: "gi-2" } });
    grnDetail.mockReturnValue({ data: { grn: { id: "grn-9", grn_number: "GRN-9", supplier_id: "sup-1", warehouse_id: "wh-1" } }, isLoading: false, isError: false });
    addGrnItem.mockReturnValue({ mutateAsync, isPending: false });
    outstandingPoItems.mockReturnValue(loaded([
      poLine({ poItemId: "poi-1", itemCode: "SOFA-A", unitPriceSen: 100 }),
      poLine({ poItemId: "poi-2", itemCode: "SOFA-B", unitPriceSen: 100 }),
    ]));
    at(`${convertToLink("poToGrn", "po-1")}&appendToGrn=grn-9`);

    fireEvent.click(screen.getByRole("button", { name: /Add 2 lines to GRN/ }));
    await waitFor(() => expect(screen.getByText(/1 of 2 lines were added/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add 1 line to GRN/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
    expect(mutateAsync.mock.calls.map((c) => (c[0] as { purchaseOrderItemId: string }).purchaseOrderItemId))
      .toEqual(["poi-1", "poi-2", "poi-2"]);
  });
});
