// The phone surface of AutoCount Sync.
//
// The point of this file is the PAIRING: mobile must show the same states, the
// same headline, the same two filter strips and the same three-part reason as
// the desktop page, because they are one product with one logic layer. Fixing a
// rule on one surface and not the other is a recurring bug class here — so most
// of what is asserted below is asserted against the SHARED helper rather than
// against a copy of its output, which is what would catch the two drifting.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));

import { MobileAutoCountSync } from "./MobileAutoCountSync";
import {
  AC_REASON_COPY,
  acHeadline,
  acWritebackLine,
  type AcOutboxResponse,
  type AcOutboxRow,
} from "../lib/autocountOutbox";

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
    /* Kept in the fixture even though the page no longer prints it — otherwise
       the "no coding words" test below would pass because the server said
       nothing, not because the page refused to repeat it. */
    state_meaning: { pending: "Queued. The 5-minute cron will send it." },
    skip_kinds: [{ kind: "keyless-line", remedy: "backfill linked_ac_dtlkey" }],
  },
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

const chip = (name: RegExp) => screen.getByRole("button", { name });

const busy = payload({
  counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 },
  rows: [
    row({ id: "f", doc_no: "SO-F", doc_type: "SO", status: "failed", state: "failed", attempts: 6,
      needs_attention: true, reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
    row({ id: "k", doc_no: "DO-K", doc_type: "DO", op: "so_to_do", status: "skipped", state: "skipped",
      needs_attention: true,
      reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
      reason_kind: "missing-location", remedy: "set the warehouse on the line" }),
    row({ id: "r", doc_no: "IV-R", doc_type: "IV", op: "do_to_iv", status: "skipped", state: "requeued",
      reason: "[re-queued 2026-08-14T10:00:00.000Z -> outbox ob-9] refused, nothing sent (ItemCodeError): 9028-1S" }),
  ],
});

describe("MobileAutoCountSync — the same product, one surface over", () => {
  it("shows the same headline sentence the desktop page shows", async () => {
    await mount(busy);
    expect(await screen.findByText(acHeadline(busy).text)).toBeTruthy();
  });

  it("shows the same switch sentence, from the same helper", async () => {
    const off = payload({ writeback: { value: "On ", on: false, scope: "off" } });
    await mount(off);
    expect(await screen.findByText(new RegExp(acWritebackLine(off).slice(0, 40)))).toBeTruthy();
  });

  it("carries BOTH filter strips, each chip with its count", async () => {
    await mount(busy);
    expect(await screen.findByRole("button", { name: /Everything\s*5/ })).toBeTruthy();
    expect(chip(/Needs attention\s*2/)).toBeTruthy();
    expect(chip(/Not accepted\s*1/)).toBeTruthy();
    expect(chip(/Every type\s*3/)).toBeTruthy();
    expect(chip(/Sales orders\s*1/)).toBeTruthy();
    expect(chip(/Delivery orders\s*1/)).toBeTruthy();
    expect(chip(/Goods received\s*0/)).toBeTruthy();
  });

  it("filters by document type on this side, without asking the server for one type", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /Delivery orders\s*1/ }));
    expect(await screen.findByText("DO-K")).toBeTruthy();
    expect(screen.queryByText("SO-F")).toBeNull();
    for (const call of apiGet.mock.calls) expect(String(call[0])).not.toContain("docType");
  });

  it("asks the server again when a status chip is clicked", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /Held back\s*1/ }));
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=skipped");
  });
});

describe("MobileAutoCountSync — the reason is on the row here too", () => {
  it("gives a held-back document the same three parts the desktop page gives it", async () => {
    await mount(busy);
    const copy = AC_REASON_COPY["missing-location"]!;
    expect(await screen.findByText(copy.headline)).toBeTruthy();
    expect(screen.getByText(copy.explain)).toBeTruthy();
    /* Two of them: the held-back row and the not-accepted row both carry one. */
    expect(screen.getAllByText("To fix").length).toBe(2);
    expect(screen.getByText(new RegExp(copy.toFix.slice(0, 30)))).toBeTruthy();
  });

  it("makes the same distinction about who was asked", async () => {
    await mount(busy);
    const card = (await screen.findByText("DO-K")).closest(".card")!;
    expect(within(card as HTMLElement).getByText("AutoCount was not asked")).toBeTruthy();
    const failed = screen.getByText("SO-F").closest(".card")!;
    expect(within(failed as HTMLElement).getByText("AutoCount replied")).toBeTruthy();
    expect(within(failed as HTMLElement).getByText(/FK_SO_SalesAgent/)).toBeTruthy();
  });

  it("marks a re-queued refusal as history, not an open item", async () => {
    await mount(busy);
    expect(await screen.findByText(/record of the first refusal/i)).toBeTruthy();
  });

  it("prints none of the machinery, even when the server sends it", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    const text = document.body.textContent;
    for (const bad of ["autocount_writeback", "linked_ac_dtlkey", "create_so", "so_to_do", "cron"]) {
      expect(text, bad).not.toContain(bad);
    }
  });
});

describe("MobileAutoCountSync — the failures it must not swallow", () => {
  it("states a load failure instead of showing an empty list", async () => {
    await mount(new Error("the queue is unreachable"));
    expect(await screen.findByText(/The queue could not be read/)).toBeTruthy();
  });

  it("says nothing has ever been queued rather than showing a blank screen", async () => {
    await mount(payload());
    expect(await screen.findByText(/Nothing has ever been queued for AutoCount/)).toBeTruthy();
  });

  it("says try another filter when the filters emptied the list", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /Purchase orders\s*0/ }));
    expect(await screen.findByText(/Try another status or another document type/)).toBeTruthy();
  });
});
