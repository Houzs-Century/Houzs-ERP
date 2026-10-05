// The AI Usage page against a mocked API: this month's total, the partial-month
// note, and the per-feature / per-company tables follow the selected month.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));

import { AiUsage, fmtRm, monthLabel, type AiUsageReport } from "./AiUsage";

afterEach(cleanup);
beforeEach(() => { apiGet.mockReset(); });

const feature = (name: string, rm: number, failures = 0) => ({
  feature: name, calls: 10, failures, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, rm,
});

const REPORT: AiUsageReport = {
  usdToRm: 4.7,
  firstRecordedAt: "2026-10-01T02:00:00.000Z",
  months: [
    {
      month: "2026-09", totalRm: 12.5, partial: true,
      note: "Only agents were measured this month; other AI features were not recorded yet.",
      features: [feature("agent:delivery", 12.5)], companies: [{ companyId: null, companyName: null, rm: 12.5 }],
    },
    {
      month: "2026-10", totalRm: 40, partial: false, note: null,
      features: [feature("scan_so", 30, 2), feature("bill_extract", 10)],
      companies: [{ companyId: 1, companyName: "Houzs Century", rm: 40 }],
    },
  ],
};

function mount() {
  apiGet.mockResolvedValue(REPORT);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/ai-usage"]}>
        <AiUsage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AI Usage page", () => {
  it("formats months and RM", () => {
    expect(monthLabel("2026-10")).toMatch(/Oct/);
    expect(fmtRm(1234.5)).toBe("RM 1,234.50");
  });

  it("opens on this month and switches to a partial month with its note", async () => {
    mount();
    expect(await screen.findByText("scan_so")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith("/api/admin/ai-usage?months=6");
    expect(screen.getByText("Houzs Century")).toBeTruthy();
    expect(screen.queryByText(/Only agents were measured/)).toBeNull();

    const sep = screen.getAllByRole("button").find((b) => b.textContent.includes("RM 12.50"));
    await userEvent.click(sep!);
    expect(await screen.findByText(/Only agents were measured/)).toBeTruthy();
    expect(screen.getByText("agent:delivery")).toBeTruthy();
    expect(screen.getByText(/Not tied to a company/)).toBeTruthy();
  });
});
