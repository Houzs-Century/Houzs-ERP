/* "Save as sales report": the look before the save (owner 2026-10-14). Pinned:
   the dialog previews what the server read — each bill with whether it is
   already saved and already an order — then saves the same text with the chat
   message id, tells the person what happened, and never saves a message with
   no bill lines. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SalesReportPreview } from "../lib/projectSalesBills";

const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../api/client", () => ({ api: { post: (p: string, b: unknown) => post(p, b) } }));

const { SalesReportSaveDialog } = await import("./SalesReportSaveDialog");

const PREVIEW: SalesReportPreview = {
  date: { day: 11, month: 10 },
  report_date: "2026-10-11",
  total_sen: 1149900,
  skipped: [{ line: 5, text: "foc pillow" }],
  warnings: [],
  bills: [
    { line: 2, ref_raw: "HC8993", ref_token: "HC8993", amount_sen: 650000, salesperson_name: "Jason", existing: false, sales_rep_id: 11,
      match: { status: "opened", so_doc_no: "HC-SO-2609-104", so_status: "CONFIRMED", so_project_id: 344, so_salesperson_id: "s", so_amount_sen: 650000, other_event: false, unlinked: false } },
    { line: 3, ref_raw: "HC10785", ref_token: "HC10785", amount_sen: 499900, salesperson_name: "Melvin", existing: true, sales_rep_id: 12,
      match: { status: "not_opened", so_doc_no: null, so_status: null, so_project_id: null, so_salesperson_id: null, so_amount_sen: null, other_event: false, unlinked: false } },
  ],
};
const TEXT = "11/10 Akemi @ SUNWAY KLUANG MALL\n1. HC8993 RM6500 Jason\n2. HC10785 RM4999 Melvin\nfoc pillow\nTotal - RM 11,499";

function toast() {
  return { success: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof SalesReportSaveDialog>[0]["toast"];
}

describe("SalesReportSaveDialog", () => {
  test("previews the read, then saves the same text against the chat message and reports the outcome", async () => {
    post.mockImplementation(async (path) => {
      if (path.endsWith("/preview")) return PREVIEW;
      return { saved: 2, notified: 1, totals: { opened_count: 1 } };
    });
    const t = toast();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SalesReportSaveDialog projectId={344} activityId={77} text={TEXT} onClose={onClose} onSaved={onSaved} toast={t} />);

    await waitFor(() => expect(screen.getByText("HC8993")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/api/project-sales-bills/344/preview", { text: TEXT });
    expect(screen.getByText(/2 bills · RM 11,499.00 · 2026-10-11 · 1 already saved/)).toBeTruthy();
    expect(screen.getByText("Opened")).toBeTruthy();
    expect(screen.getByText("Not opened")).toBeTruthy();
    expect(screen.getByText("already saved")).toBeTruthy();
    expect(screen.getByText("foc pillow")).toBeTruthy();

    fireEvent.click(screen.getByText("Save 2 bills"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/api/project-sales-bills/344", { text: TEXT, source_activity_id: 77 });
    expect(t.success).toHaveBeenCalledWith("Saved 2 bills to this event · 1 salesperson notified about a wrong event");
    expect(onClose).toHaveBeenCalled();
  });

  test("a message with no bill lines cannot be saved, and a failed preview shows its message", async () => {
    post.mockResolvedValueOnce({ ...PREVIEW, bills: [], skipped: [], total_sen: null, report_date: null });
    const { unmount } = render(<SalesReportSaveDialog projectId={344} activityId={null} text="hello" onClose={() => {}} onSaved={() => {}} toast={toast()} />);
    await waitFor(() => expect(screen.getByText(/No bill lines were found/)).toBeTruthy());
    expect((screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
    unmount();

    post.mockRejectedValueOnce(new Error("403: Only the owner, Ummu or Wei Siang can save a sales report."));
    render(<SalesReportSaveDialog projectId={344} activityId={null} text={TEXT} onClose={() => {}} onSaved={() => {}} toast={toast()} />);
    await waitFor(() => expect(screen.getByText("403: Only the owner, Ummu or Wei Siang can save a sales report.")).toBeTruthy());
  });
});
