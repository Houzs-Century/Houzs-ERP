// The phone surface of AutoCount Sync.
//
// The point of this file is the PAIRING: mobile must show the same states, the
// same headline and the same reasons as the desktop page, because they are one
// product with one logic layer. Fixing a rule on one surface and not the other
// is a recurring bug class here.
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));

import { MobileAutoCountSync } from "./MobileAutoCountSync";
import { acHeadline, type AcOutboxResponse, type AcOutboxRow } from "../lib/autocountOutbox";

afterEach(cleanup);
/* Braces, not a concise arrow — see the comment in pages/autoCountSync.test.tsx
   and the BUG-HISTORY entry. A returned mock becomes vitest's teardown. */
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
  meta: { max_attempts: 6, state_meaning: {}, skip_kinds: [] },
  ...over,
});

async function mount(body: AcOutboxResponse | Error) {
  if (body instanceof Error) apiGet.mockRejectedValue(body);
  else apiGet.mockResolvedValue(body);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MobileAutoCountSync onBack={() => {}} />
    </QueryClientProvider>,
  );
  return screen.findByText("AutoCount Sync");
}

const busy = payload({
  counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 },
  rows: [
    row({ id: "f", doc_no: "SO-F", status: "failed", state: "failed", attempts: 6, needs_attention: true,
      reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
    row({ id: "k", doc_no: "SO-K", status: "skipped", state: "skipped", needs_attention: true,
      reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
      reason_kind: "missing-location", remedy: "set the warehouse on the line" }),
    row({ id: "r", doc_no: "SO-R", status: "skipped", state: "requeued",
      reason: "[re-queued 2026-08-14T10:00:00.000Z -> outbox ob-9] refused, nothing sent (ItemCodeError): 9028-1S" }),
  ],
});

describe("MobileAutoCountSync", () => {
  it("shows the same headline sentence the desktop page shows", async () => {
    await mount(busy);
    /* Asserted against the shared helper rather than against a copy of the
       string: if the two surfaces ever stopped sharing acHeadline, this is what
       would catch it. */
    expect(await screen.findByText(acHeadline(busy).text)).toBeTruthy();
  });

  it("puts every reason on screen, in full", async () => {
    await mount(busy);
    expect(await screen.findByText(/FK_SO_SalesAgent/)).toBeTruthy();
    expect(screen.getByText(/line 2 carries no warehouse/)).toBeTruthy();
    expect(screen.getByText(/9028-1S/)).toBeTruthy();
  });

  it("names the remedy for a refusal", async () => {
    await mount(busy);
    expect(await screen.findByText(/set the warehouse on the line/)).toBeTruthy();
  });

  it("marks a re-queued skip as history, not an open item", async () => {
    await mount(busy);
    expect(await screen.findByText(/Already asked again/)).toBeTruthy();
  });

  it("reports the switch and its raw value", async () => {
    await mount(payload({ writeback: { value: "On ", on: false, scope: "off" } }));
    expect(await screen.findByText(/Write-back is OFF/)).toBeTruthy();
    expect(screen.getByText(/scm.autocount_writeback = "On "/)).toBeTruthy();
  });

  it("states a load failure instead of showing an empty list", async () => {
    await mount(new Error("the queue is unreachable"));
    expect(await screen.findByText(/The queue could not be read/)).toBeTruthy();
  });

  it("says nothing has ever been queued rather than showing a blank screen", async () => {
    await mount(payload());
    expect(await screen.findByText(/Nothing has ever been queued for AutoCount/)).toBeTruthy();
  });
});
