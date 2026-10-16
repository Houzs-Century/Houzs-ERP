// The OCR page against a mocked API: the month comes from the URL, and the
// three tables show what the report says (accuracy only where it is recorded).
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));

import { OcrDashboard, pct, type OcrReport } from "./OcrDashboard";

afterEach(cleanup);
beforeEach(() => { apiGet.mockReset(); });

const stats = (documentType: string, over: Partial<OcrReport["docTypes"][number]>) => ({
  documentType, scans: 10, pending: 0, failed: 0, discarded: 0, awaiting: 0, clean: 0, corrected: 0, imported: 0,
  accuracy: null, avgSec: 12.34, p90Sec: 20, ...over,
});

const REPORT: OcrReport = {
  month: "2026-09",
  model: "claude-sonnet-4-6",
  docTypes: [
    stats("SO", { clean: 9, corrected: 1, failed: 2, accuracy: { clean: 9, reviewed: 10 } }),
    stats("PI", { imported: 10 }),
  ],
  fieldMisses: { reviewed: 10, fields: [{ field: "Product code", count: 1 }] },
  problems: [
    { id: "a", at: "2026-09-10T01:00:00.000Z", documentType: "SO", docNo: "SO-2609-001", outcome: "corrected", detail: "Product code" },
    { id: "b", at: "2026-09-09T01:00:00.000Z", documentType: "PI", docNo: null, outcome: "failed", detail: "Supplier not matched" },
  ],
};

describe("OCR page", () => {
  it("reads the month from the URL and lays out the report", async () => {
    apiGet.mockResolvedValue(REPORT);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/ocr?month=2026-09"]}>
          <OcrDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText("Sales slip (SO)")).length).toBeGreaterThan(0);
    expect(apiGet).toHaveBeenCalledWith("/api/admin/ocr?month=2026-09");
    expect(screen.getByText("not recorded")).toBeTruthy();
    expect(screen.getByRole("link", { name: "SO-2609-001" }).getAttribute("href")).toBe("/scm/sales-orders/SO-2609-001");
    expect(screen.getByText("Supplier not matched")).toBeTruthy();
    expect(screen.getByText("none created")).toBeTruthy();
    expect(pct(9, 10)).toBe("90.0%");
  });
});
