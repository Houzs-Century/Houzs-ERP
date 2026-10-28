/* Sim, 2026-10-20: the Goods Receipt side panel shows each line's rack and lets
 * it be picked there, without opening the full page and pressing Edit. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mutate: vi.fn(), split: [] as Array<{ grnItemId: string; rackId: string; qty: number }>, canOperate: true }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true, pageAccess: () => "edit" }) }));
vi.mock("../../auth/salesAccess", () => ({ canOperateGoodsReceipts: () => h.canOperate }));
vi.mock("../../vendor/scm/lib/grn-queries", () => ({
  useGrnItemRacks: () => ({ data: h.split }),
  useSetGrnLineRack: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock("../../vendor/scm/lib/grn-line-rack", async (orig) => {
  const actual = await orig<typeof import("../../vendor/scm/lib/grn-line-rack")>();
  const racks = [{ id: "r172", rack: "Rack R17.2" }, { id: "r112", rack: "Rack R11.2" }];
  return {
    ...actual,
    useGrnRackOptions: () => ({ racks, options: actual.grnRackOptions(racks), labelById: new Map(racks.map((r) => [r.id, r.rack])), isLoading: false }),
  };
});

import { GrnDrawerRack } from "./GrnDrawerRack";

afterEach(cleanup);
beforeEach(() => { h.mutate.mockReset(); h.split = []; h.canOperate = true; });

const line = { id: "i1", item_code: "8030-2A(LHF)", rack_id: null, qty_accepted: 1 };

describe("GrnDrawerRack", () => {
  it("offers the warehouse's racks on a draft line and saves the pick at once", () => {
    render(<GrnDrawerRack grnId="g1" status="DRAFT" warehouseId="kl" line={line} />);
    const select = screen.getByLabelText("Rack for 8030-2A(LHF)") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Pick a rack", "Rack R11.2", "Rack R17.2"]);
    fireEvent.change(select, { target: { value: "r172" } });
    expect(h.mutate).toHaveBeenCalledWith({ grnId: "g1", itemId: "i1", rackId: "r172" }, expect.anything());
  });

  it("shows the saved rack as the picked value", () => {
    render(<GrnDrawerRack grnId="g1" status="POSTED" warehouseId="kl" line={{ ...line, rack_id: "r172" }} />);
    expect((screen.getByLabelText("Rack for 8030-2A(LHF)") as HTMLSelectElement).value).toBe("r172");
  });

  it("a line split over two racks is shown, not changed here", () => {
    h.split = [{ grnItemId: "i1", rackId: "r172", qty: 1 }, { grnItemId: "i1", rackId: "r112", qty: 1 }];
    render(<GrnDrawerRack grnId="g1" status="DRAFT" warehouseId="kl" line={{ ...line, qty_accepted: 2 }} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Rack R17.2 ×1, Rack R11.2 ×1")).toBeTruthy();
  });

  it("read-only for someone who cannot operate goods receipts, or on a cancelled GRN", () => {
    h.canOperate = false;
    const { unmount } = render(<GrnDrawerRack grnId="g1" status="DRAFT" warehouseId="kl" line={{ ...line, rack_id: "r112" }} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Rack R11.2 ×1")).toBeTruthy();
    unmount();
    h.canOperate = true;
    render(<GrnDrawerRack grnId="g1" status="CANCELLED" warehouseId="kl" line={line} />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says when the rack was not saved", () => {
    h.mutate.mockImplementation((_v: unknown, opts: { onError: (e: Error) => void }) => opts.onError(new Error("That rack is not in this GRN's receive-into warehouse.")));
    render(<GrnDrawerRack grnId="g1" status="DRAFT" warehouseId="kl" line={line} />);
    fireEvent.change(screen.getByLabelText("Rack for 8030-2A(LHF)"), { target: { value: "r112" } });
    expect(screen.getByRole("alert").textContent).toBe("That rack is not in this GRN's receive-into warehouse.");
  });
});
