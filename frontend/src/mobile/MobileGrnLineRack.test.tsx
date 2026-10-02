/* The phone's GRN line Rack (owner 2026-10-01: "手机端也加上rack"). A pick saves
   at once through the same hook as desktop; a closed receipt or a person who
   may not operate receipts sees the label only. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MobileGrnLineRack } from "./MobileGrnLineRack";

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  put: vi.fn(),
  rows: [] as { grnItemId: string; rackId: string; qty: number }[],
  operate: true,
  decode: null as ((v: string) => void) | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}));

vi.mock("../lib/use-qr-scanner", () => ({
  useQrScanner: (onDecoded: (v: string) => void) => {
    h.decode = onDecoded;
    return {
      scanning: true, cameraError: null, torchSupported: false, torchOn: false,
      videoRef: { current: null }, start: h.start, stop: h.stop, toggleTorch: async () => {},
    };
  },
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ can: () => true, pageAccess: () => "edit" }),
}));
vi.mock("../auth/salesAccess", () => ({
  canOperateGoodsReceipts: () => h.operate,
}));
vi.mock("../vendor/scm/lib/warehouse-queries", () => ({
  useRacks: () => ({ data: { racks: [{ id: "R2", rack: "L2.1" }, { id: "R1", rack: "L1.1" }] }, isLoading: false }),
}));
vi.mock("../vendor/scm/lib/grn-queries", () => ({
  useSetGrnLineRack: () => ({ mutate: h.mutate, isPending: false }),
  useGrnItemRacks: () => ({ data: h.rows, isLoading: false }),
  useSetGrnLineRacks: () => ({ mutate: h.put, isPending: false }),
}));

const LINE = { id: "I1", rack_id: null, qty_accepted: 10 };
const header = (status: string) => ({ status, warehouse_id: "W1" });

beforeEach(() => {
  h.mutate.mockReset();
  h.put.mockReset();
  h.rows = [];
  h.operate = true;
  h.decode = null;
  h.start.mockClear();
  h.stop.mockClear();
});

describe("MobileGrnLineRack", () => {
  it("saves a picked rack on a POSTED receipt", async () => {
    const onSaved = vi.fn();
    h.mutate.mockImplementation((_v, opts: { onSuccess: () => void }) => opts.onSuccess());
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("POSTED")} line={LINE} onSaved={onSaved} />);
    const select = screen.getByLabelText("Rack") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["— No rack —", "L1.1", "L2.1"]);
    fireEvent.change(select, { target: { value: "R1" } });
    expect(h.mutate.mock.calls[0][0]).toEqual({ grnId: "G1", itemId: "I1", rackId: "R1" });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("shows the server refusal inline", async () => {
    h.mutate.mockImplementation((_v, opts: { onError: (e: Error) => void }) => opts.onError(new Error("These goods were already moved on the rack board.")));
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("POSTED")} line={{ id: "I1", rack_id: "R2" }} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Rack"), { target: { value: "R1" } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/already moved/);
  });

  it("is read-only on a CANCELLED receipt and for a view-only person", () => {
    const { rerender } = render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("CANCELLED")} line={{ id: "I1", rack_id: "R2" }} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText("Rack")).toBeNull();
    expect(screen.getByText("L2.1")).toBeTruthy();
    h.operate = false;
    rerender(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("POSTED")} line={{ id: "I1", rack_id: "R2" }} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText("Rack")).toBeNull();
  });

  it("on a POSTED receipt, scanning a rack sticker saves that rack and closes the camera", async () => {
    const onSaved = vi.fn();
    h.mutate.mockImplementation((_v, opts: { onSuccess: () => void }) => opts.onSuccess());
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("POSTED")} line={LINE} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    expect(h.start).toHaveBeenCalled();
    act(() => h.decode!("HZRACK:L2.1"));
    expect(h.mutate.mock.calls[0][0]).toEqual({ grnId: "G1", itemId: "I1", rackId: "R2" });
    expect(h.stop).toHaveBeenCalled();
    expect(screen.queryByLabelText("Close scanner")).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("keeps the camera open and explains a sticker from another warehouse", () => {
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("POSTED")} line={LINE} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    act(() => h.decode!("HZRACK:R9.9"));
    expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/R9\.9 is not in this receipt's warehouse/);
    act(() => h.decode!("https://erp.houzscentury.com/d/abc"));
    expect(screen.getByRole("status").textContent).toMatch(/not a rack label/);
    expect(screen.getByLabelText("Close scanner")).toBeTruthy();
  });

  it("offers no scan where the rack cannot be changed", () => {
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("CANCELLED")} line={LINE} onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /scan/i })).toBeNull();
  });

  it("shows a posted split, which moves on the rack board", () => {
    h.rows = [{ grnItemId: "I1", rackId: "R1", qty: 6 }, { grnItemId: "I1", rackId: "R2", qty: 4 }];
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("POSTED")} line={LINE} onSaved={vi.fn()} />);
    expect(screen.getByText("L1.1 × 6 · L2.1 × 4")).toBeTruthy();
    expect(screen.queryByLabelText("Rack")).toBeNull();
  });

  it("renders nothing outside a goods receipt", () => {
    const { container } = render(<MobileGrnLineRack moduleKey="purchase-invoices" grnId="G1" header={header("POSTED")} line={LINE} onSaved={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("MobileGrnLineRack on a DRAFT — one line over several racks", () => {
  const draft = (line: Record<string, unknown> = LINE) =>
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("DRAFT")} line={line} onSaved={vi.fn()} />);

  it("picks a rack, defaults the qty to what is left, and saves the split", () => {
    draft();
    expect(screen.getByText("10 of 10 not on a rack yet")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Pick a rack"), { target: { value: "R1" } });
    const qty = screen.getByLabelText("Quantity on this rack") as HTMLInputElement;
    expect(qty.value).toBe("10");
    fireEvent.change(qty, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.put.mock.calls[0][0]).toEqual({ grnId: "G1", itemId: "I1", racks: [{ rackId: "R1", qty: 6 }] });
  });

  it("adds a scanned shelf to the shelves already there", () => {
    h.rows = [{ grnItemId: "I1", rackId: "R1", qty: 6 }];
    draft();
    expect(screen.getByText("L1.1 × 6")).toBeTruthy();
    expect(screen.getByText("4 of 10 not on a rack yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    act(() => h.decode!("HZRACK:L2.1"));
    expect((screen.getByLabelText("Quantity on this rack") as HTMLInputElement).value).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.put.mock.calls[0][0].racks).toEqual([{ rackId: "R1", qty: 6 }, { rackId: "R2", qty: 4 }]);
  });

  it("takes the share off the one rack the whole line was on", () => {
    draft({ id: "I1", rack_id: "R1", qty_accepted: 10 });
    fireEvent.change(screen.getByLabelText("Pick a rack"), { target: { value: "R2" } });
    fireEvent.change(screen.getByLabelText("Quantity on this rack"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.put.mock.calls[0][0].racks).toEqual([{ rackId: "R1", qty: 6 }, { rackId: "R2", qty: 4 }]);
  });

  it("refuses more than was accepted without sending, and removes a shelf", () => {
    h.rows = [{ grnItemId: "I1", rackId: "R1", qty: 6 }];
    draft();
    fireEvent.change(screen.getByLabelText("Pick a rack"), { target: { value: "R2" } });
    fireEvent.change(screen.getByLabelText("Quantity on this rack"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.put).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("The racks hold 11 but only 10 were accepted.");
    fireEvent.click(screen.getByRole("button", { name: "Remove L1.1" }));
    expect(h.put.mock.calls[0][0].racks).toEqual([]);
  });
});
