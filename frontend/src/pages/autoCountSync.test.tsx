// The desktop AutoCount Sync page, rendered against a mocked API.
//
// What is asserted is the owner's requirement, not the markup: a failed or
// skipped document must show its REASON on screen, a re-queued skip must not be
// counted as outstanding, and a load failure must be said out loud rather than
// rendered as an empty table.
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));

import { AutoCountSync } from "./AutoCountSync";
import type { AcOutboxResponse, AcOutboxRow } from "../lib/autocountOutbox";

afterEach(cleanup);
/* BRACES, not a concise arrow. `mockReset()` returns the mock, and vitest calls
   a function returned from beforeEach as that test's TEARDOWN — so
   `beforeEach(() => apiGet.mockReset())` invokes api.get after every test, and
   the rejection armed by the load-failure test below surfaced as that test
   failing with "the queue is unreachable" thrown from nowhere it could see.
   Proven 2026-08-15; see BUG-HISTORY. */
beforeEach(() => { apiGet.mockReset(); });

const row = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
  id: "ob-1",
  op: "create_so",
  doc_type: "SO",
  doc_no: "HC-SO-2608-001",
  doc_id: null,
  status: "pending",
  state: "pending",
  attempts: 0,
  reason: null,
  reason_kind: null,
  remedy: null,
  needs_attention: false,
  can_requeue: false,
  ac_doc_no: null,
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
  sent_at: null,
  ...over,
});

const payload = (over: Partial<AcOutboxResponse> = {}): AcOutboxResponse => ({
  writeback: { value: "1", on: true, scope: "1" },
  counts: { pending: 0, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 0 },
  oldest_pending: null,
  rows: [],
  truncated: false,
  meta: {
    max_attempts: 6,
    state_meaning: {
      pending: "Queued. The 5-minute cron will send it.",
      failed: "AutoCount refused it. The document is in the ERP and NOT in the account book.",
    },
    skip_kinds: [{ kind: "keyless-line", remedy: "backfill linked_ac_dtlkey" }],
  },
  ...over,
});

async function mount(body: AcOutboxResponse | Error, path = "/autocount-sync") {
  if (body instanceof Error) apiGet.mockRejectedValue(body);
  else apiGet.mockResolvedValue(body);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AutoCountSync />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.findByText("AutoCount Sync");
}

describe("AutoCountSync — is anything stuck, first", () => {
  it("names the failed and skipped documents in the headline", async () => {
    await mount(payload({
      counts: { pending: 0, sent: 2, failed: 1, skipped: 1, requeued: 0, attention: 2, total: 4 },
    }));
    expect(await screen.findByText(/2 documents need attention/)).toBeTruthy();
    expect(screen.getByText(/in the ERP and not in AutoCount/i)).toBeTruthy();
  });

  it("says the switch is off instead of reporting a stopped sync as healthy", async () => {
    await mount(payload({ writeback: { value: "off", on: false, scope: "off" } }));
    expect(await screen.findByText(/Write-back is OFF/)).toBeTruthy();
  });

  /* The raw value next to the verdict, so 'On ' is visible rather than hidden
     behind the word "off". */
  it("shows the raw switch value beside the verdict", async () => {
    await mount(payload({ writeback: { value: "On ", on: false, scope: "off" } }));
    expect(await screen.findByText(/scm.autocount_writeback = "On "/)).toBeTruthy();
  });
});

describe("AutoCountSync — every state renders its reason", () => {
  const rows = [
    row({ id: "f", doc_no: "SO-F", status: "failed", state: "failed", attempts: 6, needs_attention: true,
      reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
    row({ id: "k", doc_no: "SO-K", status: "skipped", state: "skipped", needs_attention: true,
      reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
      reason_kind: "missing-location", remedy: "set the warehouse on the line" }),
    row({ id: "p", doc_no: "SO-P", status: "pending", state: "pending", attempts: 2,
      reason: "AcSyncService threw: timeout opening the book" }),
    row({ id: "s", doc_no: "SO-S", status: "sent", state: "sent", ac_doc_no: "SO-00123",
      sent_at: "2026-08-15T01:00:00.000Z" }),
    row({ id: "r", doc_no: "SO-R", status: "skipped", state: "requeued",
      reason: "[re-queued 2026-08-14T10:00:00.000Z -> outbox ob-9] refused, nothing sent (ItemCodeError): 9028-1S" }),
  ];

  it("puts the failure, the refusal and the retry reason on screen", async () => {
    await mount(payload({
      rows,
      counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 },
    }));
    expect(await screen.findByText(/FK_SO_SalesAgent/)).toBeTruthy();
    expect(screen.getByText(/line 2 carries no warehouse/)).toBeTruthy();
    expect(screen.getByText(/timeout opening the book/)).toBeTruthy();
    expect(screen.getByText(/9028-1S/)).toBeTruthy();
    /* A sent row's proof is the account book's own number. */
    expect(screen.getByText(/AutoCount SO-00123/)).toBeTruthy();
  });

  it("prints the remedy beside the refusal it belongs to", async () => {
    await mount(payload({ rows, counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 } }));
    expect(await screen.findByText(/set the warehouse on the line/)).toBeTruthy();
  });

  it("does not clip a long AutoCount error", async () => {
    const long = `AutoCount refused it: ${"x".repeat(700)}`;
    await mount(payload({
      rows: [row({ status: "failed", state: "failed", needs_attention: true, reason: long })],
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText(long)).toBeTruthy();
  });

  it("marks a re-queued skip as history rather than an open item", async () => {
    await mount(payload({ rows, counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 } }));
    expect(await screen.findByText(/Already asked again/)).toBeTruthy();
  });

  it("says so when a refusal has no named remedy yet", async () => {
    await mount(payload({
      rows: [row({ status: "skipped", state: "skipped", needs_attention: true,
        reason: "a refusal class written next month", reason_kind: "unrecognised" })],
      counts: { pending: 0, sent: 0, failed: 0, skipped: 1, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText(/named remedy for yet/)).toBeTruthy();
  });
});

describe("AutoCountSync — filters and failure", () => {
  it("reads the state filter out of the URL", async () => {
    await mount(payload(), "/autocount-sync?state=failed");
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=failed");
  });

  it("ignores a hand-edited state the server would refuse", async () => {
    await mount(payload(), "/autocount-sync?state=planning");
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox");
  });

  /* A page written because a state went unseen must not swallow its own. */
  it("states a load failure instead of rendering an empty table", async () => {
    await mount(new Error("the queue is unreachable"));
    expect(await screen.findByText(/The queue could not be read/)).toBeTruthy();
    expect(screen.getByText(/the queue is unreachable/)).toBeTruthy();
  });

  it("tells the reader when the list is truncated but the counts are not", async () => {
    await mount(payload({
      truncated: true,
      rows: [row()],
      counts: { pending: 900, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 900 },
    }));
    expect(await screen.findByText(/Only the most recent rows are shown/)).toBeTruthy();
  });

  it("distinguishes an empty company from a filtered-out list", async () => {
    await mount(payload());
    expect(await screen.findByText(/Nothing has ever been queued for AutoCount/)).toBeTruthy();
  });
});
