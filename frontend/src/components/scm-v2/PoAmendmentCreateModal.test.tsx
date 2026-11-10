/* Sister review G18: the amendment modal minted a new idempotency key on every
 * press (`po-amd-<id>-<Date.now()>`), so a retry after a lost reply reached the
 * server as a second request. One attempt keeps one key across presses. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mutateAsync: vi.fn(), notify: vi.fn() }));

vi.mock("../../vendor/scm/lib/suppliers-queries", () => ({
  usePurchaseOrderDetail: () => ({
    data: {
      purchaseOrder: { id: "po-1", po_number: "PO-1", expected_at: "2026-12-01", notes: "" },
      items: [],
    },
  }),
}));
vi.mock("../../vendor/scm/lib/po-amendment-queries", () => ({
  useCreatePoAmendment: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => h.notify }));

import { PoAmendmentCreateModal } from "./PoAmendmentCreateModal";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { h.mutateAsync.mockReset(); h.notify.mockReset(); });

describe("PoAmendmentCreateModal idempotency key", () => {
  it("sends the same key when Submit is pressed again after a failure", async () => {
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    h.mutateAsync
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ amendment: { id: "amd-1", amendment_no: "PO-1/A1" } });

    render(<PoAmendmentCreateModal poId="po-1" poNumber="PO-1" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Header notes"), { target: { value: "new note" } });

    const submit = screen.getByRole("button", { name: "Submit amendment request" });
    fireEvent.click(submit);
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    fireEvent.click(submit);
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(2));

    const k1 = h.mutateAsync.mock.calls[0]![0].idempotencyKey;
    const k2 = h.mutateAsync.mock.calls[1]![0].idempotencyKey;
    expect(typeof k1).toBe("string");
    expect(k1.length).toBeGreaterThan(0);
    expect(k2).toBe(k1);
  });

  it("does not tell the purchaser nothing was changed after a failed press", async () => {
    h.mutateAsync.mockRejectedValueOnce(new Error("network"));
    render(<PoAmendmentCreateModal poId="po-1" poNumber="PO-1" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Header notes"), { target: { value: "new note" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit amendment request" }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(String(h.notify.mock.calls[0]![0].body)).not.toMatch(/Nothing was changed/);
  });
});
