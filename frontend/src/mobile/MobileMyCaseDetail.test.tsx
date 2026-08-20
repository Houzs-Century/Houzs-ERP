/* The mobile read-only service case — the half of the owner's 2026-07-23 rule
 * that mobile never had.
 *
 * `permissionDivergence.test.ts` pins WHO is routed here (the imported
 * `isSalesNonDirector`, the same predicate the desktop route redirects on).
 * This file renders the screen and pins WHAT the rep gets: the case, the
 * conversation, and the two writes they have always been allowed to make —
 * with a visible refusal on each, because the nudge has a guaranteed failure
 * (the server caps it at one an hour and answers 429) and a rep who is told
 * nothing presses the button again.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileMyCaseDetail } from "./MobileMyCaseDetail";

const { apiGet, apiPost, notify } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost, patch: vi.fn() },
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({
  useNotify: () => notify,
}));

const DETAIL = {
  case: {
    id: 7,
    assr_no: "ASSR-2608-007",
    stage: "pending_solution",
    priority: "high",
    doc_no: "SO-2608-001",
    ref_no: "REF-9",
    customer_name: "Tan Wei Ming",
    phone: "0123456789",
    addr1: "12 Jalan Satu",
    addr2: "Petaling Jaya",
    complained_date: "2026-08-01",
    complaint_issue: "Left armrest sags after two weeks.",
    issue_category: "Product defect",
  },
  items: [{ id: 1, item_code: "SOFA-A", item_description: "3-seater", qty: 1 }],
  activity: [
    { id: 11, action: "sales_comment", note: "Customer chased today.", created_at: "2026-08-02T01:00:00Z" },
    { id: 10, action: "customer_comment", note: "Any update?", created_at: "2026-08-01T01:00:00Z" },
    // Auto-emitted ops event — NOT part of the rep's conversation.
    { id: 12, action: "stage_change", note: "", created_at: "2026-08-03T01:00:00Z" },
  ],
};

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileMyCaseDetail id={7} onBack={vi.fn()} />
    </QueryClientProvider>,
  );
}

/* POLL, never a fixed tick. The first two drafts of this file advanced time by
   hand — three `await Promise.resolve()` ticks, then one `setTimeout(0)` — and
   both left the screen on "Loading…" often enough to fail the FIRST test in the
   file while the rest passed, because by then the module was warm. A timing
   assumption that is usually right is the worst kind: it reads as a broken
   component. `findBy*` and `waitFor` retry until the query actually settles. */

describe("MobileMyCaseDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue(DETAIL);
  });
  afterEach(cleanup);

  it("shows the case, and says out loud that it is read-only", async () => {
    renderScreen();
    expect(await screen.findByText("ASSR-2608-007")).toBeTruthy();
    // Twice on purpose: the sticky header and the Customer card. getByText
    // would throw "found multiple elements" on that, which reads as a missing
    // name rather than a duplicated one.
    expect(screen.getAllByText("Tan Wei Ming").length).toBe(2);
    expect(screen.getByText("Left armrest sags after two weeks.")).toBeTruthy();
    expect(screen.getByText("12 Jalan Satu, Petaling Jaya")).toBeTruthy();
    /* A screen quietly smaller than the one a colleague is using reads as a
       fault, so the reason is on it. */
    expect(screen.getByText(/Read-only/)).toBeTruthy();
  });

  it("prints the CANONICAL stage word, not a short form of its own", async () => {
    renderScreen();
    // ASSR_STAGE_LABEL.pending_solution — the desktop detail table used to say
    // "Solution" here, which is the drift this module keeps producing.
    expect(await screen.findByText("Pending Solution")).toBeTruthy();
  });

  it("shows the conversation and leaves the auto-emitted ops events out of it", async () => {
    renderScreen();
    expect(await screen.findByText("Customer chased today.")).toBeTruthy();
    expect(screen.getByText("Any update?")).toBeTruthy();
    expect(screen.getByText("Conversation (2)")).toBeTruthy();
  });

  it("posts a sales comment", async () => {
    apiPost.mockResolvedValue({});
    renderScreen();
    fireEvent.change(await screen.findByPlaceholderText(/Update ops/), {
      target: { value: "Customer is escalating." },
    });
    fireEvent.click(screen.getByText("Post"));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/assr/7/sales-comment", {
        text: "Customer is escalating.",
      }),
    );
  });

  it("RENDERS the refusal when a nudge is rate-limited, instead of doing nothing", async () => {
    apiPost.mockRejectedValue(new Error("Already nudged in the last hour."));
    renderScreen();
    fireEvent.click(await screen.findByText("Nudge office"));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "error", body: "Already nudged in the last hour." }),
      ),
    );
  });

  it("renders a failed load rather than an empty case", async () => {
    apiGet.mockRejectedValue(new Error("boom"));
    renderScreen();
    expect(await screen.findByText(/Couldn’t load this case/)).toBeTruthy();
  });

  it("offers NO write control — no stage change, no advance, no archive", async () => {
    renderScreen();
    await screen.findByText("Overview");
    for (const gone of ["Advance", "Archive", "Close case", "Change stage to", "Edit"]) {
      expect(screen.queryByText(gone), `the read-only screen offers "${gone}"`).toBeNull();
    }
    expect(document.querySelector("select")).toBeNull();
  });
});
