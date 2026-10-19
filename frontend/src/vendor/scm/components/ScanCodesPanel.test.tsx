/* HC-0120 (Sim, 19 Oct 2026): the scan card lets the warehouse say which item a
 * supplier's printed code is, pre-filled from the name match, free gifts left
 * out, and saves only the codes given a line. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ authed: vi.fn() }));
vi.mock("../lib/authed-fetch", () => ({ authedFetch: (...a: unknown[]) => h.authed(...a) }));
vi.mock("../lib/mutation-error", () => ({ writeFailed: vi.fn() }));

import { ScanCodesPanel } from "./ScanCodesPanel";

const lines = [
  { poItemId: "l1", poNumber: "HC-PO-2610-084", itemCode: "AKEMI BULWARK MATT (K)", materialName: null, remaining: 1 },
  { poItemId: "l2", poNumber: "HC-PO-2610-084", itemCode: "AKEMI BULWARK MATT (K)", materialName: null, remaining: 1 },
  { poItemId: "l3", poNumber: "HC-PO-2610-084", itemCode: "AKEMI ULTIMATE MATT (K)", materialName: null, remaining: 1 },
];
const codes = {
  data: {
    supplierKnown: true,
    rows: [
      { printedCode: "T1MAMWA0MK", description: "Mattress Akemi Bulwark K King", qty: 2, status: "name_matched", suggestedPoItemId: "l1" },
      { printedCode: "AFKPAK25A23J29W", description: "GWP Pillow Acc", qty: 4, status: "not_matched", suggestedPoItemId: null },
    ],
    poLines: lines,
  },
};

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ScanCodesPanel jobId="job-1" jobsQueryKey={["jobs"]} />
    </QueryClientProvider>,
  );

afterEach(cleanup);
beforeEach(() => { h.authed.mockReset(); });

describe("ScanCodesPanel", () => {
  it("pre-fills the name match, offers each item once with what the PO owes, and leaves gifts off the PO", async () => {
    h.authed.mockResolvedValueOnce(codes);
    renderIt();
    const bulwark = (await screen.findByLabelText("Item for T1MAMWA0MK")) as HTMLSelectElement;
    expect(bulwark.value).toBe("l1");
    expect([...bulwark.options].map((o) => o.text)).toEqual([
      "Not on the PO",
      "AKEMI BULWARK MATT (K) (HC-PO-2610-084, owes 2)",
      "AKEMI ULTIMATE MATT (K) (HC-PO-2610-084, owes 1)",
    ]);
    expect((screen.getByLabelText("Item for AFKPAK25A23J29W") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("matched by name")).toBeTruthy();
  });

  it("saves only the codes given a line and says the next delivery order will match", async () => {
    h.authed.mockResolvedValueOnce(codes).mockResolvedValueOnce({ data: { saved: 1, draft: null } });
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 code" }));
    await waitFor(() => expect(h.authed).toHaveBeenCalledTimes(2));
    const [path, init] = h.authed.mock.calls[1]!;
    expect(path).toBe("/scan-gr/jobs/job-1/codes");
    expect(JSON.parse(init.body)).toEqual({ pairs: [{ printedCode: "T1MAMWA0MK", poItemId: "l1" }] });
    expect(await screen.findByText(/1 code saved for this supplier\. The next delivery order/)).toBeTruthy();
  });

  it("says so when the supplier is not known", async () => {
    h.authed.mockResolvedValueOnce({ data: { supplierKnown: false, rows: [], poLines: [] } });
    renderIt();
    expect(await screen.findByText(/could not tell which supplier/)).toBeTruthy();
  });
});
