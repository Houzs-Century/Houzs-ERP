// The desktop AutoCount Sync page, rendered against a mocked API.
//
// What is asserted is the owner's requirement, not the markup: the counts are on
// something clickable, the two strips filter and the type counts follow the
// status filter, a refused document says WHY in three plain-language parts on
// the row, AutoCount's own reply is quoted and labelled with whether AutoCount
// was ever asked, no machinery vocabulary reaches the screen, and a load failure
// is said out loud rather than rendered as an empty table.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost } }));

import { AutoCountSync } from "./AutoCountSync";
import type { AcOutboxResponse, AcOutboxRow } from "../lib/autocountOutbox";

afterEach(cleanup);
/* BRACES, not a concise arrow. `mockReset()` returns the mock, and vitest calls
   a function returned from beforeEach as that test's TEARDOWN — so
   `beforeEach(() => apiGet.mockReset())` invokes api.get after every test, and
   the rejection armed by the load-failure test below surfaced as that test
   failing with "the queue is unreachable" thrown from nowhere it could see.
   Proven 2026-08-15; see BUG-HISTORY. */
beforeEach(() => { apiGet.mockReset(); apiPost.mockReset(); });

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
    /* The server still ships these and the page no longer prints them — they
       were written for a workflow log. Left in the fixture on purpose: the
       "no coding words" test below would pass for the wrong reason if the
       fixture quietly stopped carrying the sentence that says "cron". */
    state_meaning: { pending: "Queued. The 5-minute cron will send it." },
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

const chip = (name: RegExp) => screen.getByRole("button", { name });

const rows = [
  row({ id: "f", doc_no: "SO-F", doc_type: "SO", op: "create_so", status: "failed", state: "failed",
    attempts: 6, needs_attention: true, can_requeue: true,
    reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
  row({ id: "k", doc_no: "DO-K", doc_type: "DO", op: "so_to_do", status: "skipped", state: "skipped",
    needs_attention: true,
    reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
    reason_kind: "missing-location", remedy: "set the warehouse on the line" }),
  row({ id: "p", doc_no: "SO-P", doc_type: "SO", status: "pending", state: "pending", attempts: 2,
    reason: "AcSyncService threw: timeout opening the book" }),
  row({ id: "s", doc_no: "GR-S", doc_type: "GR", op: "po_to_gr", status: "sent", state: "sent",
    ac_doc_no: "GR-00123", sent_at: "2026-08-15T01:00:00.000Z" }),
  row({ id: "r", doc_no: "IV-R", doc_type: "IV", op: "do_to_iv", status: "skipped", state: "requeued",
    reason: "[re-queued 2026-08-14T10:00:00.000Z -> outbox ob-9] refused, nothing sent (ItemCodeError): 9028-1S" }),
];

const busy = payload({
  rows,
  counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 },
});

describe("AutoCountSync — is anything stuck, first", () => {
  it("names the documents that need attention in the headline", async () => {
    await mount(busy);
    expect(await screen.findByText(/2 documents need your attention/)).toBeTruthy();
    expect(screen.getAllByText(/in the ERP and not in the account book/i).length).toBeGreaterThan(0);
  });

  it("says sending is switched off instead of reporting a stopped sync as healthy", async () => {
    await mount(payload({ writeback: { value: "off", on: false, scope: "off" } }));
    /* Twice on purpose: the verdict says it, and the line under the strips says
       it again next to the value the switch is actually set to. */
    expect((await screen.findAllByText(/Sending to AutoCount is switched off/)).length).toBe(2);
  });

  /* A typo like 'On ' is OFF, and the page has to make that visible without
     naming the config row it lives in. */
  it("shows a switch value that does not read as on", async () => {
    await mount(payload({ writeback: { value: "On ", on: false, scope: "off" } }));
    expect(await screen.findByText(/does not read as on/)).toBeTruthy();
    expect(screen.queryByText(/autocount_writeback/)).toBeNull();
  });
});

describe("AutoCountSync — the counts are on something you can click", () => {
  it("puts every status on a chip with the server's exact count", async () => {
    await mount(busy);
    expect(await screen.findByRole("button", { name: /Everything\s*5/ })).toBeTruthy();
    expect(chip(/Needs attention\s*2/)).toBeTruthy();
    expect(chip(/Not accepted\s*1/)).toBeTruthy();
    expect(chip(/Held back\s*1/)).toBeTruthy();
    expect(chip(/In AutoCount\s*1/)).toBeTruthy();
    expect(chip(/Sent again\s*1/)).toBeTruthy();
  });

  it("offers all six document types, spelled out, each with its own count", async () => {
    await mount(busy);
    expect(await screen.findByRole("button", { name: /Every type\s*5/ })).toBeTruthy();
    expect(chip(/Sales orders\s*2/)).toBeTruthy();
    expect(chip(/Delivery orders\s*1/)).toBeTruthy();
    expect(chip(/Invoices\s*1/)).toBeTruthy();
    expect(chip(/Goods received\s*1/)).toBeTruthy();
    /* Not "Purchase orders" plus an invented row — a type with nothing in it
       still shows, at zero, so the strip is the same shape every time. */
    expect(chip(/Purchase orders\s*0/)).toBeTruthy();
    expect(chip(/Supplier invoices\s*0/)).toBeTruthy();
  });

  it("asks the server again when a status chip is clicked, and recounts the types", async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(url.includes("state=failed")
        ? payload({
          rows: [rows[0]!],
          counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 },
        })
        : busy));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/autocount-sync"]}>
          <AutoCountSync />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: /Sales orders\s*2/ })).toBeTruthy();

    await userEvent.click(chip(/Not accepted\s*1/));

    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=failed");
    /* The type counts are of the rows now on screen, so they MOVED — that is the
       point of putting them on the chips rather than on a tile. */
    expect(await screen.findByRole("button", { name: /Sales orders\s*1/ })).toBeTruthy();
    expect(chip(/Delivery orders\s*0/)).toBeTruthy();
    /* The status counts did NOT move: they are the server's, exact and
       whole-company, regardless of what is being listed. */
    expect(chip(/Everything\s*5/)).toBeTruthy();
  });

  it("filters the list by type without asking the server for one type", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /Delivery orders\s*1/ }));
    expect(await screen.findByText("DO-K")).toBeTruthy();
    expect(screen.queryByText("SO-F")).toBeNull();
    for (const call of apiGet.mock.calls) expect(String(call[0])).not.toContain("docType");
  });

  it("names both filters over the list", async () => {
    await mount(busy, "/autocount-sync?state=skipped&docType=DO");
    expect(await screen.findByText("Held back · Delivery orders")).toBeTruthy();
  });
});

describe("AutoCountSync — the reason is on the row", () => {
  it("gives a held-back document a headline, an explanation and a To fix, all inline", async () => {
    await mount(busy);
    const card = (await screen.findByText("DO-K")).closest("li")!;
    expect(within(card).getByText(/does not say which warehouse the stock comes from/i)).toBeTruthy();
    expect(within(card).getByText(/AutoCount will not take a document whose lines carry no warehouse/i)).toBeTruthy();
    expect(within(card).getByText("To fix")).toBeTruthy();
    expect(within(card).getByText(/Set the warehouse on that line/)).toBeTruthy();
  });

  /* The distinction the owner asked for: the ERP refused this one itself, so
     nothing ever reached the account book. */
  it("says AutoCount was not asked when the ERP stopped the document itself", async () => {
    await mount(busy);
    const card = (await screen.findByText("DO-K")).closest("li")!;
    expect(within(card).getByText("AutoCount was not asked")).toBeTruthy();
    expect(within(card).getByText(/stopped this before it was ever sent/i)).toBeTruthy();
    expect(within(card).queryByText("AutoCount replied")).toBeNull();
  });

  it("quotes AutoCount's own reply, verbatim and unclipped, on a refused document", async () => {
    const long = `AutoCount refused it: ${"x".repeat(700)}`;
    await mount(payload({
      rows: [row({ status: "failed", state: "failed", needs_attention: true, reason: long })],
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText("AutoCount replied")).toBeTruthy();
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByText(/AutoCount would not take this document/)).toBeTruthy();
  });

  it("does not pretend AutoCount answered when nothing came back", async () => {
    await mount(payload({
      rows: [row({ status: "failed", state: "failed", needs_attention: true, reason: null })],
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText("AutoCount said nothing")).toBeTruthy();
  });

  /* A refusal nobody has words for yet is a code path that grew a new refusal.
     The raw note is the answer in that one case, so it is not collapsed. */
  it("opens the exact note when the refusal has no plain wording yet", async () => {
    await mount(payload({
      rows: [row({ status: "skipped", state: "skipped", needs_attention: true,
        reason: "a refusal class written next month", reason_kind: "unrecognised" })],
      counts: { pending: 0, sent: 0, failed: 0, skipped: 1, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText(/no wording for yet/)).toBeTruthy();
    const details = screen.getByText("Show the exact note the ERP wrote down").closest("details")!;
    expect(details.open).toBe(true);
    expect(screen.getByText("a refusal class written next month")).toBeTruthy();
  });

  it("marks a re-queued refusal as history rather than something to act on", async () => {
    await mount(busy);
    const card = (await screen.findByText("IV-R")).closest("li")!;
    expect(within(card).getByText(/record of the first refusal/i)).toBeTruthy();
    expect(within(card).queryByText("To fix")).toBeNull();
  });

  it("shows what a waiting document is waiting on, without claiming AutoCount said it", async () => {
    await mount(busy);
    const card = (await screen.findByText("SO-P")).closest("li")!;
    expect(within(card).getByText("The last send attempt reported")).toBeTruthy();
    expect(within(card).getByText(/timeout opening the book/)).toBeTruthy();
  });

  it("proves an arrived document with the account book's own number", async () => {
    await mount(busy);
    expect(await screen.findByText(/In the account book as GR-00123/)).toBeTruthy();
  });
});

describe("AutoCountSync — no coding words anywhere", () => {
  it("prints none of the machinery, even when the server sends it", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    const text = document.body.textContent;
    for (const bad of [
      "scm.autocount_writeback",
      "autocount_writeback",
      "AddPartialTransferDetail",
      "linked_ac_dtlkey",
      "create_so",
      "so_to_do",
      "do_to_iv",
      "po_to_gr",
      "cron",
      "SDK",
    ]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it("names each operation and each type in words", async () => {
    await mount(busy);
    expect(await screen.findByText("Delivery order from a sales order")).toBeTruthy();
    expect(screen.getByText("Goods received from a purchase order")).toBeTruthy();
    expect(screen.getAllByText("New sales order").length).toBe(2);
  });

  /* The five tiles are gone. Their subtitles were the only place these phrases
     appeared, so their absence is the check that the redesign actually landed
     rather than being added beside the old one. */
  it("no longer carries the five dead summary tiles", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    expect(screen.queryByText("Declined on purpose, remedy named")).toBeNull();
    expect(screen.queryByText("Refusals already asked again")).toBeNull();
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

  it("ignores a hand-edited document type rather than filtering to nothing", async () => {
    await mount(busy, "/autocount-sync?docType=ZZ");
    expect(await screen.findByText("SO-F")).toBeTruthy();
  });

  /* A page written because a state went unseen must not swallow its own. */
  it("states a load failure instead of rendering an empty table", async () => {
    await mount(new Error("the queue is unreachable"));
    expect(await screen.findByText(/The queue could not be read/)).toBeTruthy();
    expect(screen.getByText(/the queue is unreachable/)).toBeTruthy();
  });

  it("says the status counts still cover everything when the list is cut short", async () => {
    await mount(payload({
      truncated: true,
      rows: [row()],
      counts: { pending: 900, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 900 },
    }));
    expect(await screen.findByText(/Only the most recent documents are shown/)).toBeTruthy();
  });

  it("distinguishes an empty company from a filtered-out list", async () => {
    await mount(payload());
    expect(await screen.findByText(/Nothing has ever been queued for AutoCount/)).toBeTruthy();
  });

  it("says try another filter when the filters emptied the list", async () => {
    await mount(busy, "/autocount-sync?docType=PI");
    expect(await screen.findByText(/Try another status or another document type/)).toBeTruthy();
  });
});

/* The button the previous version of this page deliberately did NOT have. It
   ships now because #2321 landed POST /:id/requeue; what is asserted here is the
   half that gets forgotten — the answer, on the row, in every direction it can
   go. */
describe("AutoCountSync — Send again", () => {
  const requeueAnswer = (over: Record<string, unknown> = {}) => ({
    accepted: true,
    code: "requeued",
    message: "Sent back to the queue. It goes to AutoCount on the next five-minute sweep.",
    row_id: "f",
    doc_type: "SO",
    doc_no: "SO-F",
    op: "create_so",
    new_row_id: "ob-9",
    reason: null,
    ...over,
  });

  it("offers the button only where the server says a re-send can mean something", async () => {
    await mount(busy);
    const offered = (await screen.findByText("SO-F")).closest("li")!;
    expect(within(offered).getByRole("button", { name: "Send again" })).toBeTruthy();
    /* DO-K is held back and can_requeue is false on it — no button rather than
       a button that always answers no. */
    const notOffered = screen.getByText("DO-K").closest("li")!;
    expect(within(notOffered).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("says so on the row when the document is on its way again", async () => {
    apiPost.mockResolvedValue(requeueAnswer());
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(apiPost).toHaveBeenCalledWith("/api/scm/autocount-outbox/f/requeue");
    expect(await screen.findByText(/Sent back to the queue/)).toBeTruthy();
    /* An accepted re-send makes a NEW row, so the page re-reads rather than
       patching the one it has. */
    expect(apiGet.mock.calls.length).toBeGreaterThan(1);
  });

  /* THE BRANCH THAT GETS FORGOTTEN. A refusal RESOLVES — it is the server
     answering — and its sentence is the whole value of pressing the button when
     the answer is "AutoCount already has it". Rendering only the accepted half
     is "the button does nothing" wearing a success path. */
  it("prints the refusal on the row instead of looking like nothing happened", async () => {
    apiPost.mockResolvedValue(requeueAnswer({
      accepted: false,
      code: "already-sent",
      message: "AutoCount already accepted this one. Sending it again would put a SECOND copy of the document in the account book.",
      new_row_id: null,
    }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText(/AutoCount already accepted this one/)).toBeTruthy();
  });

  it("shows the ERP's own words when it refuses the document a second time", async () => {
    apiPost.mockResolvedValue(requeueAnswer({
      accepted: false,
      code: "still-refused",
      message: "The ERP still will not send it.",
      new_row_id: null,
      reason: "refused, nothing sent (MissingAgentError): no salesperson on HC-SO-2608-004",
    }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText(/The ERP still will not send it/)).toBeTruthy();
    expect(screen.getByText(/no salesperson on HC-SO-2608-004/)).toBeTruthy();
  });

  it("says the call never got through, rather than swallowing the throw", async () => {
    apiPost.mockRejectedValue(new Error("the worker is unreachable"));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy();
    expect(screen.getByText(/the worker is unreachable/)).toBeTruthy();
  });
});
