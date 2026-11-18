// The OCR page against a mocked API: the month comes from the URL, and the
// three tables show what the report says (accuracy only where it is recorded).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, fetchSlip } = vi.hoisted(() => ({ apiGet: vi.fn(), fetchSlip: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));
vi.mock("../vendor/scm/lib/slip", () => ({ fetchScanSlipImageBlobUrl: fetchSlip }));

import { OcrDashboard, pct, type OcrReport } from "./OcrDashboard";

afterEach(cleanup);
beforeEach(() => {
  apiGet.mockReset();
  fetchSlip.mockReset();
});

const stats = (documentType: string, label: string, over: Partial<OcrReport["docTypes"][number]>) => ({
  documentType, label, scans: 10, pending: 0, failed: 0, discarded: 0, awaiting: 0, clean: 0, corrected: 0, imported: 0,
  accuracy: null, avgSec: 12.34, p90Sec: 20, ...over,
});

const REPORT: OcrReport = {
  month: "2026-09",
  model: "claude-sonnet-4-6",
  docTypes: [
    stats("SO", "Sales slip (SO)", { clean: 9, corrected: 1, failed: 2, accuracy: { clean: 9, reviewed: 10 } }),
    stats("PI", "Supplier invoice (PI)", { imported: 10 }),
  ],
  fieldMisses: { reviewed: 10, fields: [{ field: "Product code", count: 1 }] },
  problems: [
    {
      id: "a", at: "2026-09-10T01:00:00.000Z", documentType: "SO", docNo: "SO-2609-001", outcome: "corrected", detail: "Product code",
      changes: [{ field: "Line 1 Product code", before: "A1", after: "B2" }], slipImageKey: "scan-slips/s1",
    },
    { id: "b", at: "2026-09-09T01:00:00.000Z", documentType: "PI", docNo: null, outcome: "failed", detail: "Supplier not matched", changes: null, slipImageKey: null },
  ],
};

function renderPage(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <OcrDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OCR page", () => {
  it("reads the month from the URL and lays out the report", async () => {
    apiGet.mockResolvedValue(REPORT);
    renderPage("/ocr?month=2026-09");
    expect((await screen.findAllByText("Sales slip (SO)")).length).toBeGreaterThan(0);
    expect(apiGet).toHaveBeenCalledWith("/api/admin/ocr?month=2026-09");
    expect(screen.getByText("not recorded")).toBeTruthy();
    expect(screen.getAllByText("Supplier not matched").length).toBeGreaterThan(0);
    expect(screen.getByText("1 change")).toBeTruthy();
    expect(screen.getByText("Line 1 Product code")).toBeTruthy();
    expect(screen.getByText("A1")).toBeTruthy();
    expect(screen.getByText("none created")).toBeTruthy();
    expect(pct(9, 10)).toBe("90.0%");
  });

  it("opens the slip beside its changes on the same page instead of leaving for the sales order", async () => {
    apiGet.mockResolvedValue(REPORT);
    fetchSlip.mockResolvedValue("blob:slip");
    renderPage("/ocr?month=2026-09");

    fireEvent.click(await screen.findByRole("button", { name: "SO-2609-001" }));

    const drawer = screen.getByRole("dialog", { name: "Slip check for SO-2609-001" });
    expect(fetchSlip).toHaveBeenCalledWith("scan-slips/s1");
    expect((await within(drawer).findByAltText("The scanned slip for SO-2609-001")).getAttribute("src")).toBe("blob:slip");
    expect(within(drawer).getByText("Line 1 Product code")).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Open sales order" }).getAttribute("href")).toBe("/scm/sales-orders/SO-2609-001");

    fireEvent.click(within(drawer).getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when the scan kept no slip photo", async () => {
    apiGet.mockResolvedValue({ ...REPORT, problems: [{ ...REPORT.problems[0], slipImageKey: null }] });
    renderPage("/ocr?month=2026-09&slip=a");
    const drawer = await screen.findByRole("dialog", { name: "Slip check for SO-2609-001" });
    expect(within(drawer).getByText("No slip photo was kept for this scan.")).toBeTruthy();
    expect(fetchSlip).not.toHaveBeenCalled();
  });
});
