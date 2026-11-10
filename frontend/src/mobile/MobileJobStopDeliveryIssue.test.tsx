/* "Report a problem" on a non-DO run-sheet job (a Service Case leg here): the
 * job stays completed and the report goes to the job's own issue route. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/lib/slip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/slip")>()),
  uploadSlipFull: vi.fn(async ({ file }: { file: File }) => ({ r2Key: `slips/2026/11/${file.name}` })),

  // No photos uploaded earlier for this stop (the re-list after a reload).
  listFieldPhotos: vi.fn(async () => []),
}));

import { MobileJobStop } from "./MobileJobStop";

type Init = { method?: string; body?: string };
beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/delivery-planning/delivery-issues")) return { issues: [] };
    if (url.endsWith("/issue")) return { issue: { id: "iss-9", assr_no: "ASSR/2611-009" } };
    return {
      job: { sourceType: "assr", sourceId: "12", leg: "delivery", trip_id: null },
      context: { kind: "delivery", title: "A Customer", ref: "ASSR/2610-001" },
      progress: { source_type: "assr", source_id: "12", leg: "delivery", departed_at: "2026-11-09T01:00:00Z", arrived_at: "2026-11-09T02:00:00Z", completed_at: "2026-11-09T03:00:00Z", pod_photo_keys: [] },
    };
  });
});
afterEach(cleanup);

describe("MobileJobStop — report a problem on a completed job", () => {
  it("sends the ticked problems to the job's issue route", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MobileJobStop jobRef={{ sourceType: "assr", sourceId: "12", leg: "delivery" }} seq={3} onBack={vi.fn()} onDone={vi.fn()} /></QueryClientProvider>);
    fireEvent.click(await screen.findByText("Report a problem"));
    const form = screen.getByTestId("delivery-issue-form");
    fireEvent.click(within(form).getByLabelText("Customer refused part"));
    fireEvent.click(screen.getByText("Send report"));
    await waitFor(() => expect(authedFetch.mock.calls.some(([u]) => String(u).endsWith("/issue"))).toBe(true));
    const [url, init] = authedFetch.mock.calls.find(([u]) => String(u).endsWith("/issue")) as [string, Init];
    expect(url).toBe("/delivery-jobs/assr/12/delivery/issue");
    expect(JSON.parse(init.body!)).toEqual({ kinds: ["customer_refused"], note: null, photoKeys: [] });
    // The job was not completed again.
    expect(authedFetch.mock.calls.some(([u]) => String(u).endsWith("/complete"))).toBe(false);
  });
});
