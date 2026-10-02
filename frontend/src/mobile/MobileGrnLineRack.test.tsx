/* The phone's GRN line Rack (owner 2026-10-01: "手机端也加上rack"). A pick saves
   at once through the same hook as desktop; a closed receipt or a person who
   may not operate receipts sees the label only. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MobileGrnLineRack } from "./MobileGrnLineRack";

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
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
}));

const LINE = { id: "I1", rack_id: null };
const header = (status: string) => ({ status, warehouse_id: "W1" });

beforeEach(() => {
  h.mutate.mockReset();
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

  it("scanning a rack sticker saves that rack and closes the camera", async () => {
    const onSaved = vi.fn();
    h.mutate.mockImplementation((_v, opts: { onSuccess: () => void }) => opts.onSuccess());
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("DRAFT")} line={LINE} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    expect(h.start).toHaveBeenCalled();
    act(() => h.decode!("HZRACK:L2.1"));
    expect(h.mutate.mock.calls[0][0]).toEqual({ grnId: "G1", itemId: "I1", rackId: "R2" });
    expect(h.stop).toHaveBeenCalled();
    expect(screen.queryByLabelText("Close scanner")).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("keeps the camera open and explains a sticker from another warehouse", () => {
    render(<MobileGrnLineRack moduleKey="grns" grnId="G1" header={header("DRAFT")} line={LINE} onSaved={vi.fn()} />);
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

  it("renders nothing outside a goods receipt", () => {
    const { container } = render(<MobileGrnLineRack moduleKey="purchase-invoices" grnId="G1" header={header("POSTED")} line={LINE} onSaved={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
