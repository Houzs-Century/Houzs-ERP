// HC-0031: a work order keeps the workshop's quotation, invoice and photos.
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { putBinary, del, fetchBlobUrl } = vi.hoisted(() => ({ putBinary: vi.fn(), del: vi.fn(), fetchBlobUrl: vi.fn() }));
vi.mock("../api/client", () => ({ api: { putBinary, del, fetchBlobUrl } }));

import { WorkOrderFiles, fileLabel } from "./FleetHealthWorkOrderFiles";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("WorkOrderFiles", () => {
  it("shows the file name out of the server key", () => {
    expect(fileLabel("fleet/work-orders/w1/invoice/1700-Inv_77.pdf")).toBe("Inv_77.pdf");
    expect(fileLabel("fleet/work-orders/w1/photo/5.jpg")).toBe("5.jpg");
  });

  it("lists each kind and removes a file by its key", async () => {
    del.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<WorkOrderFiles wo={{ id: "w1", invoiceRefs: ["fleet/work-orders/w1/invoice/1-inv.pdf"], photoRefs: [] }} onChanged={onChanged} />);
    expect(screen.getByText("Invoice:")).toBeTruthy();
    expect(screen.queryByText("Photos:")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remove inv.pdf"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(del).toHaveBeenCalledWith("/api/fleet-work-order-files/w1?key=fleet%2Fwork-orders%2Fw1%2Finvoice%2F1-inv.pdf");
  });

  it("uploads one file at a time under the chosen kind", async () => {
    putBinary.mockResolvedValue({});
    const onChanged = vi.fn();
    render(<WorkOrderFiles wo={{ id: "w1" }} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "quote" } });
    const a = new File(["a"], "q1.pdf", { type: "application/pdf" });
    const b = new File(["b"], "q2.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [a, b] } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(putBinary.mock.calls.map((c) => c[0])).toEqual([
      "/api/fleet-work-order-files/w1?kind=quote&ext=pdf&name=q1.pdf",
      "/api/fleet-work-order-files/w1?kind=quote&ext=png&name=q2.png",
    ]);
  });

  it("says so when an upload is refused", async () => {
    putBinary.mockRejectedValue(new Error("Max 15MB."));
    render(<WorkOrderFiles wo={{ id: "w1" }} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [new File(["a"], "big.pdf")] } });
    expect(await screen.findByText("Max 15MB.")).toBeTruthy();
  });
});
