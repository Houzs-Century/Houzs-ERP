// The desktop AutoCount Sync page, rendered against a mocked API.
//
// What is asserted is the owner's requirement, not the markup: the counts are on
// something clickable, the two strips filter and the type counts follow the
// status filter, a refused document says WHY on the row, AutoCount's own reply
// is quoted and labelled with whether AutoCount was ever asked, no machinery
// vocabulary reaches the screen, and a load failure is said out loud rather than
// rendered as an empty table.
//
// AND, since 2026-08-16, the four things he asked for after reading it at scale
// ("一个 sales order 那么宽，那如果我有一千个 sales order 的时候，我不是完蛋？"):
// the page OPENS on what needs attention, a problem row shows ONE line of
// reason, a document already in the account book shows nothing to open at all,
// and several hundred rows do not all go into the page. Those four have their
// own describe block at the bottom, because they are the ones a future tidy-up
// is most likely to undo by accident.
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
  can_send_now: false,
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
  counts_complete: true,
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

/* `data-ac-row`, not `li`: the list is windowed now and the windowing component
   owns the element that wraps each row. A test that reaches for the wrapper is
   asserting the virtualiser's markup, which is not this page's contract.
   `data-ac-doc` is looked at FIRST because the register prints a document number
   twice on a healthy row — in *Document* and, identically, in *In the book as* —
   so `getByText` finds two nodes and throws. The text fallback stays for
   anything that is not a register cell. */
const cardOf = (docNo: string): HTMLElement => {
  const cell = [...document.querySelectorAll<HTMLElement>("[data-ac-doc]")]
    .find((el) => el.textContent === docNo);
  return (cell ?? screen.getByText(docNo)).closest("[data-ac-row]") as HTMLElement;
};

/**
 * Open a row by its always-visible reason line — the line IS the opener.
 *
 * Asked for by `data-ac-why` rather than by "the first collapsed button in the
 * row", which stopped being unambiguous when the register gave the *Sends* cell
 * its own `aria-expanded` for the send history. Two openers on one row is the
 * normal shape now, and a test that picks by position picks whichever the
 * markup happens to put first.
 */
async function openRow(docNo: string) {
  const card = cardOf(docNo);
  await userEvent.click(card.querySelector("[data-ac-why]") as HTMLElement);
  return cardOf(docNo);
}

/**
 * Everything on a card EXCEPT the collapsed technical block.
 *
 * Asked STRUCTURALLY, because "not on screen" cannot be asked any other way
 * here: jsdom does not apply the user-agent stylesheet, so a closed `<details>`
 * still contributes its whole content to `textContent` and a plain
 * `expect(body.textContent).not.toContain(…)` would be red no matter where the
 * text sits. `data-ac-technical` is a test hook the way `data-ac-row` already
 * is — it names the contract (this is the part behind the disclosure), not the
 * styling.
 */
const plainTextOf = (el: HTMLElement): string => {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of copy.querySelectorAll("[data-ac-technical]")) n.remove();
  return copy.textContent;
};

/** Open the fold that history sits behind. */
async function openReplacedGroup() {
  await userEvent.click(
    screen.getByRole("button", { name: /replaced documents?, kept as a record/ }),
  );
}

const rows = [
  row({ id: "f", doc_no: "SO-F", doc_type: "SO", op: "create_so", status: "failed", state: "failed",
    attempts: 6, needs_attention: true, can_requeue: true,
    reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
  row({ id: "k", doc_no: "DO-K", doc_type: "DO", op: "so_to_do", status: "skipped", state: "skipped",
    needs_attention: true,
    reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
    reason_kind: "missing-location", remedy: "set the warehouse on the line" }),
  /* WAITING with tries left, so the server offers it a Send now. */
  row({ id: "p", doc_no: "SO-P", doc_type: "SO", status: "pending", state: "pending", attempts: 2,
    can_send_now: true,
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
    expect(await screen.findByText(/2 documents are not in the account book/)).toBeTruthy();
    expect(screen.getAllByText(/not in the account book/i).length).toBeGreaterThan(0);
  });

  it("says sending is switched off instead of reporting a stopped sync as healthy", async () => {
    await mount(payload({ writeback: { value: "off", on: false, scope: "off" } }));
    /* Once: the verdict (headline) says it. The second line under the strips that
       repeated it — the writeback bar — was removed in the 2026-08-21 declutter. */
    expect((await screen.findAllByText(/Sending to AutoCount is switched off/)).length).toBe(1);
  });

  /* The writeback bar that spelled out a typo'd switch value ("set to 'On ',
     which does not read as on") was removed in the 2026-08-21 declutter. The
     headline still says the sync is off; the value-level hint is gone by design. */
});

describe("AutoCountSync — the counts are on something you can click", () => {
  it("puts every status on a chip with the server's exact count", async () => {
    await mount(busy);
    /* Four tabs now (owner 2026-08-21). "Not accepted" is the merged stuck
       bucket = attention (failed 1 + skipped 1 = 2). */
    expect(await screen.findByRole("button", { name: /All\s*5/ })).toBeTruthy();
    expect(chip(/Waiting\s*1/)).toBeTruthy();
    expect(chip(/Not accepted\s*2/)).toBeTruthy();
    expect(chip(/In AutoCount\s*1/)).toBeTruthy();
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
    /* Click "In AutoCount" (sent), NOT "Not accepted": the page now DEFAULTS to
       the Not accepted (attention) tab, so clicking it would be a no-op and never
       ask the server again. In AutoCount is a real state change from the default. */
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(url.includes("state=sent")
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

    await userEvent.click(chip(/In AutoCount\s*1/));

    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=sent");
    /* The type counts are of the rows now on screen, so they MOVED — that is the
       point of putting them on the chips rather than on a tile. */
    expect(await screen.findByRole("button", { name: /Sales orders\s*1/ })).toBeTruthy();
    expect(chip(/Delivery orders\s*0/)).toBeTruthy();
    /* The status counts did NOT move: they are the server's, exact and
       whole-company, regardless of what is being listed. */
    expect(chip(/All\s*5/)).toBeTruthy();
  });

  it("filters the list by type without asking the server for one type", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /Delivery orders\s*1/ }));
    expect(await screen.findByText("DO-K")).toBeTruthy();
    expect(screen.queryByText("SO-F")).toBeNull();
    for (const call of apiGet.mock.calls) expect(String(call[0])).not.toContain("docType");
  });

  it("names both filters over the list", async () => {
    await mount(busy, "/autocount-sync?state=attention&docType=DO");
    expect(await screen.findByText("Not accepted · Delivery orders")).toBeTruthy();
  });
});

describe("AutoCountSync — the reason is on the row", () => {
  /* THE HEADLINE IS NEVER HIDDEN. He rejected a design where the whole reason
     sat behind a "Why not" click, and shortening the row must not smuggle that
     back in — so the headline is on the row, and it is the thing you click. */
  it("keeps the plain-language headline on a held-back row without any click", async () => {
    await mount(busy);
    await screen.findByText("DO-K");
    expect(
      within(cardOf("DO-K")).getByText(/does not say which warehouse the stock comes from/i),
    ).toBeTruthy();
  });

  it("puts the explanation, the To fix line and the machine's words behind opening the row", async () => {
    await mount(busy);
    await screen.findByText("DO-K");
    const card = cardOf("DO-K");
    expect(within(card).queryByText(/AutoCount will not take a document whose lines carry no warehouse/i)).toBeNull();
    expect(within(card).queryByText("To fix")).toBeNull();
    expect(within(card).queryByText("AutoCount was not asked")).toBeNull();

    const opened = await openRow("DO-K");

    expect(within(opened).getByText(/AutoCount will not take a document whose lines carry no warehouse/i)).toBeTruthy();
    expect(within(opened).getByText("To fix")).toBeTruthy();
    expect(within(opened).getByText(/Set the warehouse on that line/)).toBeTruthy();
  });

  /* The distinction the owner asked for: the ERP refused this one itself, so
     nothing ever reached the account book. One layer down, not flattened. */
  it("says AutoCount was not asked when the ERP stopped the document itself", async () => {
    await mount(busy);
    await screen.findByText("DO-K");
    const card = await openRow("DO-K");
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
    expect(await screen.findByText(/AutoCount would not take this document/)).toBeTruthy();
    const card = await openRow("HC-SO-2608-001");
    expect(within(card).getByText("AutoCount replied")).toBeTruthy();
    expect(within(card).getByText(long)).toBeTruthy();
  });

  it("does not pretend AutoCount answered when nothing came back", async () => {
    await mount(payload({
      rows: [row({ status: "failed", state: "failed", needs_attention: true, reason: null })],
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    }));
    await screen.findByText("HC-SO-2608-001");
    const card = await openRow("HC-SO-2608-001");
    expect(within(card).getByText("AutoCount said nothing")).toBeTruthy();
  });

  /* A refusal nobody has words for yet is a code path that grew a new refusal.
     The raw note is the answer in that one case, so THAT row arrives open —
     shortening every other row must not take this back. */
  it("arrives open when the refusal has no plain wording yet", async () => {
    await mount(payload({
      rows: [row({ status: "skipped", state: "skipped", needs_attention: true,
        reason: "a refusal class written next month", reason_kind: "unrecognised" })],
      counts: { pending: 0, sent: 0, failed: 0, skipped: 1, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText(/no wording for yet/)).toBeTruthy();
    expect(screen.getByText("a refusal class written next month")).toBeTruthy();
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
  });

  /* Folded away by default since 2026-08-16 — see the superseded block at the
     bottom of this file. Everything it said about the row is still true, and it
     is still all there; it is one click further away. */
  it("marks a replaced refusal as a record rather than something to act on", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    await openReplacedGroup();
    /* The badge, the one-line status and the headline all say it, which is the
       point — they used to say "Sent again", "Already sent again under a newer
       row" and "Already sent again — this row is history". */
    expect(within(cardOf("IV-R")).getByText("Replaced")).toBeTruthy();
    expect(
      within(cardOf("IV-R")).getByText(/Replaced by a newer send — nothing to do on this one/),
    ).toBeTruthy();
    const card = await openRow("IV-R");
    expect(within(card).getByText(/record of the first refusal/i)).toBeTruthy();
    expect(within(card).queryByText("To fix")).toBeNull();
  });

  it("shows what a waiting document is waiting on, without claiming AutoCount said it", async () => {
    await mount(busy);
    await screen.findByText("SO-P");
    expect(within(cardOf("SO-P")).getByText("The last send attempt reported")).toBeTruthy();
    const card = await openRow("SO-P");
    expect(within(card).getByText(/timeout opening the book/)).toBeTruthy();
  });

  /* The account book's own number is on the ROW now, in its own column, rather
     than folded into a sentence — and `GR-S` came back as `GR-00123`, so this
     one is also the flagged case. The unflagged case is in the register block
     at the bottom of this file. */
  it("proves an arrived document with the account book's own number", async () => {
    await mount(busy);
    await screen.findByText("GR-S");
    expect(within(cardOf("GR-S")).getByText("GR-00123")).toBeTruthy();
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
    await screen.findByText("DO-K");
    /* EXACT matches now: the operation has its own column (*What was sent*) and
       the type has another (*Type*), so neither is a fragment of a longer
       sentence any more. The words are still what is asserted. */
    expect(within(cardOf("DO-K")).getByText("Delivery order from a sales order")).toBeTruthy();
    expect(within(cardOf("DO-K")).getByText("Delivery order")).toBeTruthy();
    expect(within(cardOf("GR-S")).getByText("Goods received from a purchase order")).toBeTruthy();
    expect(within(cardOf("SO-F")).getByText("New sales order")).toBeTruthy();
    expect(within(cardOf("SO-F")).getByText("Sales order")).toBeTruthy();
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
    await mount(payload(), "/autocount-sync?state=attention");
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=attention");
  });

  it("ignores a hand-edited state the server would refuse", async () => {
    await mount(payload(), "/autocount-sync?state=planning");
    /* Falls back to the page's DEFAULT, which is the attention filter — not to
       everything, which is what an unknown value used to land on. */
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=attention");
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
    await screen.findByText("SO-F");
    const offered = cardOf("SO-F");
    expect(within(offered).getByRole("button", { name: "Send again" })).toBeTruthy();
    /* DO-K is held back and can_requeue is false on it — no button rather than
       a button that always answers no. */
    const notOffered = cardOf("DO-K");
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

describe("AutoCountSync — an accepted re-send stops giving orders about the old refusal", () => {
  /* "To fix: go and change it in AutoCount" on a document that has just been
     sent back to the queue is a FALSE instruction, and it would sit there for a
     whole round trip waiting on the re-read. It comes off immediately. */
  it("takes the old reason off the row the moment the document is on its way", async () => {
    apiPost.mockResolvedValue({
      accepted: true, code: "requeued",
      message: "Sent back to the queue. It goes to AutoCount on the next five-minute sweep.",
      row_id: "f", doc_type: "SO", doc_no: "SO-F", op: "create_so",
      new_row_id: "ob-9", reason: null,
    });
    await mount(busy);
    await screen.findByText("SO-F");
    const card = await openRow("SO-F");
    expect(within(card).getByText("To fix")).toBeTruthy();

    await userEvent.click(within(card).getByRole("button", { name: "Send again" }));

    expect(await screen.findByText(/Sent back to the queue/)).toBeTruthy();
    const after = cardOf("SO-F");
    /* The whole reason goes, opener and all — not just the part behind it. */
    expect(within(after).queryByText("To fix")).toBeNull();
    expect(within(after).queryByText("AutoCount replied")).toBeNull();
    expect(within(after).queryByText(/AutoCount would not take this document/)).toBeNull();
    /* Replaced by what to do NOW, keyed by the outcome code. */
    expect(within(after).getByText("To do")).toBeTruthy();
    expect(within(after).getByText(/next five-minute send/)).toBeTruthy();
  });

  it("keeps the old reason when the re-send was refused — nothing changed", async () => {
    apiPost.mockResolvedValue({
      accepted: false, code: "already-sent",
      message: "AutoCount already accepted this one.",
      row_id: "f", doc_type: "SO", doc_no: "SO-F", op: "create_so",
      new_row_id: null, reason: null,
    });
    await mount(busy);
    await screen.findByText("SO-F");
    const card = await openRow("SO-F");
    await userEvent.click(within(card).getByRole("button", { name: "Send again" }));
    expect(await screen.findByText(/AutoCount already accepted this one/)).toBeTruthy();
    const after = cardOf("SO-F");
    expect(within(after).getByText("To fix")).toBeTruthy();
    expect(within(after).getByText(/do not look for a way round it/i)).toBeTruthy();
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   The four things the owner asked for on 2026-08-16, after reading the rebuilt
   page against a real backlog: "这一个东西下面的地方太复杂了，你尽量简单化一点。一个
   sales order 那么宽，那如果我有一千个 sales order 的时候，我不是完蛋？"
   ─────────────────────────────────────────────────────────────────────────── */
describe("AutoCountSync — a thousand documents", () => {
  const manyRows = (n: number): AcOutboxRow[] =>
    Array.from({ length: n }, (_, i) => (i % 5 === 0
      ? row({ id: `x${i}`, doc_no: `SO-${i}`, status: "failed", state: "failed", attempts: 6,
        needs_attention: true, reason: "Gave up after 6 attempts." })
      : row({ id: `x${i}`, doc_no: `SO-${i}`, status: "sent", state: "sent",
        ac_doc_no: `AC-${i}`, sent_at: "2026-08-15T01:00:00.000Z" })));

  it("opens on the documents that need attention, not on everything", async () => {
    await mount(busy);
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=attention");
    /* "Not accepted" now names BOTH the filter chip and the in-force heading
       (the 4-tab simplification merged the old "Needs attention" heading wording
       into the same label as the tab). Both are spans, so a single-match query is
       ambiguous; asserting at least one is present keeps the intent — the label
       is on screen — while line 583 already proves the ATTENTION filter is the one
       asked for. */
    expect((await screen.findAllByText("Not accepted", { selector: "span" })).length).toBeGreaterThan(0);
  });

  it("keeps everything one click away", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /All\s*5/ }));
    /* No `state` on the query is how the route is asked for everything. */
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox");
  });

  /* THE MAJORITY OF A LONG LIST. A document already in the account book has
     nothing wrong with it and nothing to say, so it says nothing. */
  it("gives a document already in AutoCount one line and nothing to open", async () => {
    await mount(busy);
    await screen.findByText("GR-S");
    const card = cardOf("GR-S");
    expect(within(card).queryByRole("button", { expanded: false })).toBeNull();
    expect(within(card).queryByRole("button", { expanded: true })).toBeNull();
    expect(within(card).queryByText("To fix")).toBeNull();
    expect(within(card).queryByText("AutoCount replied")).toBeNull();
    /* It still SAYS the thing — in the register's fifth column rather than in a
       sentence. Nothing to open is not the same as nothing to read. */
    expect(within(card).getByText("GR-00123")).toBeTruthy();
  });

  /* The number the owner actually complained about. 400 rows in the DOM is the
     page he called unusable; a windowed list mounts the visible slice. */
  it("does not put several hundred rows into the page at once", async () => {
    await mount(payload({
      rows: manyRows(400),
      counts: { pending: 0, sent: 320, failed: 80, skipped: 0, requeued: 0, attention: 80, total: 400 },
    }));
    /* `SO-1`, not `SO-0`: the register sorts by WHEN, newest first, and the 320
       arrived documents carry a `sent_at` an hour after everything else's
       `created_at`, so they are the top of the list. `SO-0` is one of the 80
       refusals and is 320 rows down. */
    await screen.findByText("SO-1");
    const mounted = document.querySelectorAll("[data-ac-row]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(400);
  });

  it("says nothing needs attention rather than telling you to try another filter", async () => {
    await mount(payload({
      rows: [],
      counts: { pending: 0, sent: 900, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 900 },
    }));
    expect(await screen.findByText(/Nothing needs your attention/)).toBeTruthy();
    expect(screen.queryByText(/Try another status/)).toBeNull();
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   THE FOUR THINGS THE OWNER READ OFF THE LIVE PAGE ON 2026-08-16.

   Every fixture below is a string PRODUCTION actually holds, not an invented
   worst case. The two that matter most were both arriving from the SERVER,
   which is why the earlier "no coding words" test above was green while the
   screen was not: it checks the strings this codebase writes, and neither of
   these is one.
   ─────────────────────────────────────────────────────────────────────────── */
describe("AutoCountSync — no machine prose in the plain-language block", () => {
  /* recordParentlessCreate's sentence AS THE QUEUE STILL HOLDS IT. The writer
     stopped producing it in this same change; that fixes nothing on his screen,
     because scm.autocount_outbox is append-only and last_error is never
     rewritten. Rows already in the table keep these words for good. */
  const PARENTLESS =
    "created with no source delivery order, so there is no source document to transfer from. "
    + "AutoCount builds a DO / GRN / Invoice only by transferring a source document's lines "
    + "(AddPartialTransferDetail is the SDK's only primitive), so this document cannot be "
    + "created in the account book at all and will stay ERP-only.";

  const heldBack = payload({
    counts: { pending: 0, sent: 0, failed: 0, skipped: 1, requeued: 0, attention: 1, total: 1 },
    rows: [row({ id: "iv", doc_no: "HC-IV-2608-004", doc_type: "IV", op: "do_to_iv",
      status: "skipped", state: "skipped", needs_attention: true,
      reason_kind: "no-source-document", reason: PARENTLESS })],
  });

  it("does not print the SDK method name a held-back invoice's reason carries", async () => {
    await mount(heldBack);
    await screen.findByText("HC-IV-2608-004");
    const card = await openRow("HC-IV-2608-004");
    /* Opened, so everything the row has to say is on screen — and none of it is
       this. */
    expect(plainTextOf(card)).not.toContain("AddPartialTransferDetail");
    expect(plainTextOf(card)).not.toContain("SDK");
  });

  it("says the same thing in the ERP's own words instead, without a click", async () => {
    await mount(heldBack);
    expect(await screen.findByText(/There is no earlier document to carry across/)).toBeTruthy();
  });

  /* The distinction the owner asked for by name survives the tidy-up. */
  it("still says AutoCount was never asked about it", async () => {
    await mount(heldBack);
    await screen.findByText("HC-IV-2608-004");
    const card = await openRow("HC-IV-2608-004");
    expect(within(card).getByText("AutoCount was not asked")).toBeTruthy();
  });

  it("keeps the note itself, whole, behind the technical disclosure", async () => {
    await mount(heldBack);
    await screen.findByText("HC-IV-2608-004");
    const card = await openRow("HC-IV-2608-004");
    const technical = card.querySelector("[data-ac-technical]");
    expect(technical?.textContent).toContain("AddPartialTransferDetail");
    expect(technical?.textContent).toContain("Technical detail");
  });
});

describe("AutoCountSync — AutoCount's sentence stays, its evidence folds", () => {
  /* AcSyncService started appending the account book's own numbers per line on
     2026-08-16. It is the diagnostic that refuted the standing explanation for
     these two delivery orders — and it is four lines of Qty=1.00000000. */
  const WITH_DUMP =
    "Gave up after 6 attempts. Last error: Invalid transfer item. || source SO lines as the book "
    + "holds them: 905348 on SO HC-SO-2608-002 [AK-ULTIMATE MATT (K)] Qty=1.00000000 "
    + "TransferedQty=0.00000000 Transferable=T docCancelled=F outstanding=1.00000000; 905349 on "
    + "SO HC-SO-2608-002 [HOK-1013 (K)] Qty=1.00000000 TransferedQty=0.00000000 Transferable=T "
    + "docCancelled=F outstanding=1.00000000";

  const refused = payload({
    counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    rows: [row({ id: "do2", doc_no: "HC-DO-2608-002", doc_type: "DO", op: "so_to_do",
      status: "failed", state: "failed", attempts: 6, needs_attention: true,
      can_requeue: true, reason: WITH_DUMP })],
  });

  it("keeps AutoCount's own eleven words in view", async () => {
    await mount(refused);
    await screen.findByText("HC-DO-2608-002");
    const card = await openRow("HC-DO-2608-002");
    expect(within(card).getByText(/Invalid transfer item\./)).toBeTruthy();
    expect(within(card).getByText("AutoCount replied")).toBeTruthy();
  });

  it("takes the line-by-line dump off the plain block", async () => {
    await mount(refused);
    await screen.findByText("HC-DO-2608-002");
    const card = await openRow("HC-DO-2608-002");
    const plain = plainTextOf(card);
    expect(plain).not.toContain("TransferedQty");
    expect(plain).not.toContain("docCancelled");
    expect(plain).not.toContain("905348");
  });

  it("but keeps every number of it, behind the disclosure", async () => {
    await mount(refused);
    await screen.findByText("HC-DO-2608-002");
    const card = await openRow("HC-DO-2608-002");
    const technical = card.querySelector("[data-ac-technical]")?.textContent ?? "";
    expect(technical).toContain("905348");
    expect(technical).toContain("TransferedQty=0.00000000");
    expect(technical).toContain("outstanding=1.00000000");
  });

  /* AutoCount named no field on this row, and the lines were measured correct
     against the live book the same day. An order to fix them is worse than
     silence. */
  it("does not send anybody to fix a field AutoCount never named", async () => {
    await mount(refused);
    await screen.findByText("HC-DO-2608-002");
    const card = await openRow("HC-DO-2608-002");
    expect(within(card).queryByText(/Put right whatever AutoCount named/)).toBeNull();
    /* The To fix line itself, not the disclosure's label, which names the same
       person for the same reason. */
    expect(within(card).getByText(/Pass it to whoever looks after the AutoCount link/))
      .toBeTruthy();
    expect(within(card).getByText(/nothing on this document for you to change/)).toBeTruthy();
  });
});

describe("AutoCountSync — history is not half the list", () => {
  /* His screen: fifteen rows, SIX of them already sent again, with
     HC-DO-2608-001 and HC-DO-2608-002 each appearing twice. */
  const fifteen = payload({
    counts: { pending: 0, sent: 3, failed: 4, skipped: 2, requeued: 6, attention: 6, total: 15 },
    rows: [
      ...Array.from({ length: 6 }, (_, i) => row({
        id: `old${i}`, doc_no: i < 2 ? `HC-DO-2608-00${i + 1}` : `HC-SO-2608-00${i}`,
        status: "skipped", state: "requeued",
        reason: "[re-queued 2026-08-16T02:00:00.000Z -> outbox ob-x] refused, nothing sent (ItemCodeError): 9028-1S",
      })),
      ...Array.from({ length: 4 }, (_, i) => row({
        id: `bad${i}`, doc_no: `HC-DO-2608-10${i}`, doc_type: "DO", op: "so_to_do",
        status: "failed", state: "failed", attempts: 6, needs_attention: true,
        reason: "Gave up after 6 attempts. Last error: Invalid transfer item.",
      })),
      ...Array.from({ length: 5 }, (_, i) => row({
        id: `ok${i}`, doc_no: `HC-SO-2608-20${i}`, status: "sent", state: "sent",
        ac_doc_no: `SO-0000${i}`, sent_at: "2026-08-16T01:00:00.000Z",
      })),
    ],
  }, );

  it("keeps the six replaced documents out of the list", async () => {
    await mount(fifteen, "/autocount-sync?state=all");
    await screen.findByText("HC-DO-2608-100");
    /* Nine live rows on screen, none of them a record. */
    expect(document.querySelectorAll("[data-ac-row]").length).toBe(9);
    expect(screen.queryByText(/Replaced by a newer send/i)).toBeNull();
  });

  it("says how many there are and why they are kept", async () => {
    await mount(fifteen, "/autocount-sync?state=all");
    expect(await screen.findByRole("button", { name: /6 replaced documents, kept as a record/ }))
      .toBeTruthy();
  });

  it("shows them when asked, without moving them back into the list", async () => {
    await mount(fifteen, "/autocount-sync?state=all");
    await screen.findByText("HC-DO-2608-100");
    await openReplacedGroup();
    expect(screen.getByText(/nothing here to do/i)).toBeTruthy();
    expect(document.querySelectorAll("[data-ac-row]").length).toBe(15);
  });

  /* The dedicated "Replaced" tab was removed 2026-08-21 (four-tab simplification).
     Replaced documents are history and now appear folded under "All" — the test
     below covers that folded presentation. */
  it("does not tell a reader to try another filter when the matches are all history", async () => {
    await mount(payload({
      counts: { pending: 0, sent: 0, failed: 0, skipped: 0, requeued: 2, attention: 0, total: 2 },
      rows: [
        row({ id: "h1", doc_no: "HC-DO-2608-001", status: "skipped", state: "requeued",
          reason: "[re-queued …] refused" }),
        row({ id: "h2", doc_no: "HC-DO-2608-002", status: "skipped", state: "requeued",
          reason: "[re-queued …] refused" }),
      ],
    }), "/autocount-sync?state=all");
    expect(await screen.findByText(/Nothing live here/)).toBeTruthy();
    expect(screen.queryByText(/Try another status/)).toBeNull();
    expect(screen.getByRole("button", { name: /2 replaced documents, kept as a record/ }))
      .toBeTruthy();
  });
});

describe("AutoCountSync — a load failure is the page's sentence, not the transport's", () => {
  it("says its own line, and quotes what the transport said under it", async () => {
    await mount(new Error("AutoCount service responded 502"));
    /* One sentence the page owns, whole — not a colon and then whatever a fetch
       layer produced. */
    expect(await screen.findByText(
      "The queue could not be read, so nothing below is the current picture.",
    )).toBeTruthy();
    expect(screen.getByText("AutoCount service responded 502")).toBeTruthy();
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   ONE SALES ORDER, ONE ROW.

   Owner, 2026-08-16, reading In AutoCount / Sales orders on the live page:
   "为什么在 AutoCount 里面一张 Sales Order 会出现两次呢?" Six rows, and
   HC-SO-2608-002 was FOUR of them — three "Change to the sales order" at 16/08
   4:30-4:31pm and the original "New sales order" at 15/08 1:25am. AED_HOUZS
   holds exactly one HC-SO-2608-002, verified by direct SQL, so nothing was
   duplicated anywhere: the list was one row per SEND.
   ─────────────────────────────────────────────────────────────────────────── */
describe("AutoCountSync — one document, one row", () => {
  const sent = (over: Partial<AcOutboxRow>): AcOutboxRow =>
    row({ status: "sent", state: "sent", ac_doc_no: "SO-00002", ...over });

  /** His six rows, in the order the route returns them: newest first. */
  const hisScreen = payload({
    counts: { pending: 0, sent: 3, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 3 },
    rows: [
      sent({ id: "s4", op: "edit", doc_no: "HC-SO-2608-002",
        created_at: "2026-08-16T08:31:40.000Z", sent_at: "2026-08-16T08:31:55.000Z" }),
      sent({ id: "s3", op: "edit", doc_no: "HC-SO-2608-002",
        created_at: "2026-08-16T08:31:05.000Z", sent_at: "2026-08-16T08:31:20.000Z" }),
      sent({ id: "s2", op: "edit", doc_no: "HC-SO-2608-002",
        created_at: "2026-08-16T08:30:12.000Z", sent_at: "2026-08-16T08:30:30.000Z" }),
      sent({ id: "s1", op: "create_so", doc_no: "HC-SO-2608-002",
        created_at: "2026-08-14T17:25:00.000Z", sent_at: "2026-08-14T17:25:18.000Z" }),
      sent({ id: "o1", doc_no: "HC-SO-2608-003", ac_doc_no: "SO-00003",
        created_at: "2026-08-16T02:00:00.000Z", sent_at: "2026-08-16T02:00:10.000Z" }),
      sent({ id: "o2", doc_no: "HC-SO-2608-004", ac_doc_no: "SO-00004",
        created_at: "2026-08-16T01:00:00.000Z", sent_at: "2026-08-16T01:00:10.000Z" }),
    ],
  });

  /* THE DEFECT, AS A NUMBER: four rows for one sales order, rendered as one. */
  it("renders one sales order once, however many times it was sent", async () => {
    await mount(hisScreen, "/autocount-sync?state=sent");
    await screen.findAllByText("HC-SO-2608-002");
    expect(document.querySelectorAll("[data-ac-row]").length).toBe(3);
    expect(screen.getAllByText("HC-SO-2608-002")).toHaveLength(1);
  });

  /* AND THE COUNTS SAY THE SAME NUMBER. "6 of 17 documents" over six rows for
     three documents was the other half of what he read. */
  it("counts documents on the strips and in the line under them", async () => {
    await mount(hisScreen, "/autocount-sync?state=sent");
    await screen.findAllByText("HC-SO-2608-002");
    expect(screen.getByText("3 of 3 documents")).toBeTruthy();
    expect(chip(/Sales orders\s*3/)).toBeTruthy();
    expect(chip(/Every type\s*3/)).toBeTruthy();
  });

  /* THE SENDS ARE THE AUDIT TRAIL AND NONE OF THEM IS DROPPED. 0277 exists so
     "what did we tell AutoCount, when, and what did it answer" is a SELECT a
     year later; a page that hid three of the four would be a worse defect than
     the one being fixed. */
  it("keeps every send, one click under the document", async () => {
    await mount(hisScreen, "/autocount-sync?state=sent");
    await screen.findAllByText("HC-SO-2608-002");
    const card = cardOf("HC-SO-2608-002");
    const opener = within(card).getByRole("button", { name: /3 earlier sends for this document/ });
    /* Folded on arrival — the row is one line until it is asked. */
    expect(card.querySelectorAll("[data-ac-send]").length).toBe(0);
    await userEvent.click(opener);
    expect(cardOf("HC-SO-2608-002").querySelectorAll("[data-ac-send]").length).toBe(3);
  });

  /* The row is drawn from the NEWEST send: the document's current state is what
     happened last to it, not what happened first. */
  it("shows where the document stands now, not where it started", async () => {
    await mount(hisScreen, "/autocount-sync?state=sent");
    await screen.findAllByText("HC-SO-2608-002");
    const card = cardOf("HC-SO-2608-002");
    /* *What was sent* is the newest send's operation. The TYPE is beside it in
       its own column, which is why the operation no longer repeats it. */
    expect(within(card).getByText("Change to the document")).toBeTruthy();
    expect(within(card).getByText("Sales order")).toBeTruthy();
    expect(within(card).queryByText("New sales order")).toBeNull();
  });

  /* A document sent once has no second opener at all — the majority row must
     not grow a control it has nothing to put behind. */
  it("gives a document sent once nothing extra to open", async () => {
    await mount(hisScreen, "/autocount-sync?state=sent");
    await screen.findByText("HC-SO-2608-003");
    expect(within(cardOf("HC-SO-2608-003")).queryByRole("button")).toBeNull();
  });
});

/* A count the server could not finish must not read as a count. */
describe("AutoCountSync — a partial count says so", () => {
  it("says the numbers are a floor when the queue was too long to scan", async () => {
    await mount(payload({
      counts_complete: false,
      rows: [row({ status: "sent", state: "sent", ac_doc_no: "SO-1" })],
      counts: { pending: 0, sent: 1, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 1 },
    }), "/autocount-sync?state=all");
    expect(await screen.findByText(/at least this many and possibly more/)).toBeTruthy();
  });

  it("says nothing of the kind when it scanned the lot", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    expect(screen.queryByText(/at least this many and possibly more/)).toBeNull();
  });
});

/* SEND NOW — the WAITING row's control.
   The owner asked for a manual push beside the automatic sync
   (「自动的 可是我要可以manual push」). Until it existed a queued row had no
   button at all, because a RE-QUEUE of a pending row would put a second create
   for the same document in the queue — correctly refused. This dispatches the
   row that is already there, so the questions worth asking on this surface are
   the same three Send again answers: is it offered on the right row, does the
   answer land ON that row, and does a refusal reach the reader at all. */
describe("AutoCountSync — Send now", () => {
  const sendNowAnswer = (over: Record<string, unknown> = {}) => ({
    accepted: true,
    code: "sent-now",
    message: "Sent, and AutoCount took it. It is in the account book now — you did not have to wait for the five-minute sweep.",
    row_id: "p",
    doc_type: "SO",
    doc_no: "SO-P",
    op: "create_so",
    new_row_id: null,
    reason: null,
    ...over,
  });

  it("is offered on the waiting row, and NOT on the refused one", async () => {
    await mount(busy);
    await screen.findByText("SO-P");
    expect(within(cardOf("SO-P")).getByRole("button", { name: "Send now" })).toBeTruthy();
    /* SO-F has given up: its action is Send again, which starts a fresh set of
       attempts. Offering both would be two buttons meaning "send it". */
    expect(within(cardOf("SO-F")).queryByRole("button", { name: "Send now" })).toBeNull();
    expect(within(cardOf("SO-P")).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("pushes THAT row, and says on it that the account book took it", async () => {
    apiPost.mockResolvedValue(sendNowAnswer());
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(apiPost).toHaveBeenCalledWith("/api/scm/autocount-outbox/p/send-now");
    expect(await within(cardOf("SO-P")).findByText(/in the account book now/i)).toBeTruthy();
  });

  it("prints a REFUSAL on the row rather than swallowing it", async () => {
    apiPost.mockResolvedValue(sendNowAnswer({
      accepted: false,
      code: "already-in-flight",
      message: "It is going out right now — either the five-minute sweep picked it up, or somebody else pressed this a moment ago. Nothing was sent twice.",
    }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(await within(cardOf("SO-P")).findByText(/Nothing was sent twice/i)).toBeTruthy();
  });

  it("says so when the call never got through at all", async () => {
    apiPost.mockRejectedValue(new Error("Network request failed"));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    /* The documented failure class this repo names: a refusal that reaches
       nobody reads as "the button does nothing". */
    expect(await within(cardOf("SO-P")).findByText(/never got through/i)).toBeTruthy();
  });

  /* ONE PRESS CAN MOVE THREE DOCUMENTS, and until #0552 the page reported one.
     Every ancestor the cascade sends is a write into a licensed account book on
     the operator's behalf; showing them only the row they pressed is showing
     them the wrong thing. */
  it("names every ancestor the press sent, and WHY each had to go first", async () => {
    apiPost.mockResolvedValue(sendNowAnswer({
      ancestors_sent: [
        { doc_type: "SO", doc_no: "SO-A", code: "sent", reason: "stale" },
        { doc_type: "DO", doc_no: "DO-B", code: "sent", reason: "missing" },
      ],
    }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    const card = cardOf("SO-P");
    /* The two reasons are different facts and the page must not flatten them:
       one document was BEHIND, the other was ABSENT. */
    expect(await within(card).findByText(/SO-A — AutoCount had an older version, sent\./)).toBeTruthy();
    expect(within(card).getByText(/DO-B — AutoCount did not have it yet, sent\./)).toBeTruthy();
  });

  it("shows an ancestor that FAILED, not only the ones that worked", async () => {
    /* The dangerous shape: the pressed row succeeds while an ancestor did not.
       Reporting only the press would read as "all done". */
    apiPost.mockResolvedValue(sendNowAnswer({
      ancestors_sent: [{ doc_type: "SO", doc_no: "SO-A", code: "still-refused", reason: "missing" }],
    }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(await within(cardOf("SO-P")).findByText(/SO-A .*not sent — still-refused/)).toBeTruthy();
  });

  it("says nothing about ancestors when the press moved none", async () => {
    /* An empty heading on every ordinary press would be noise, and noise is how
       the useful case stops being read. */
    apiPost.mockResolvedValue(sendNowAnswer({ ancestors_sent: [] }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await within(cardOf("SO-P")).findByText(/in the account book now/i);
    expect(within(cardOf("SO-P")).queryByText(/Sent first/i)).toBeNull();
  });

  it("invents no ancestor list when the call never got through", async () => {
    apiPost.mockRejectedValue(new Error("Network request failed"));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await within(cardOf("SO-P")).findByText(/never got through/i);
    expect(within(cardOf("SO-P")).queryByText(/Sent first/i)).toBeNull();
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   THE REGISTER — 2026-08-21.

   The owner reviewed a mockup at the size the queue actually is and chose the
   dense-table direction over the card list. What is asserted below is the
   CONTRACT that change was signed off on, not the markup: the eight columns are
   there and named, the fifth one is silent on a match and loud on a mismatch,
   the days break the register up, the footer says how much is on screen, and
   the two lenses that were added narrow the page without narrowing the request.

   Four rulings from the earlier rounds are asserted elsewhere in this file and
   MUST keep passing: the headline stays on a problem row unclicked, the page
   opens on Needs attention, a document in the account book has nothing to open,
   and several hundred rows do not all go into the DOM.
   ─────────────────────────────────────────────────────────────────────────── */
describe("AutoCountSync — eight columns", () => {
  it("heads the register with the eight the owner approved, in order", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    for (const label of [
      "Status", "Document", "Type", "What was sent", "In the book as", "Sends", "When",
    ]) {
      expect(screen.getByText(label, { selector: "div,button" }), label).toBeTruthy();
    }
  });

  it("puts the ERP number, the type and the plain-words operation on the row", async () => {
    await mount(busy);
    await screen.findByText("DO-K");
    const card = cardOf("DO-K");
    expect(within(card).getByText("DO-K")).toBeTruthy();
    expect(within(card).getByText("Delivery order")).toBeTruthy();
    expect(within(card).getByText("Delivery order from a sales order")).toBeTruthy();
  });

  /* The try count was DELIBERATELY not made a column — it reads as a dash on
     nearly every row. It is not lost: it is a sentence inside the problem row's
     own block, where it says whether the queue is still working on this. */
  it("keeps the try count inside the problem row, not in a column of dashes", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    expect(screen.queryByText("Tries")).toBeNull();
    const card = await openRow("SO-F");
    expect(within(card).getByText(/Tried 6 times, then stopped/)).toBeTruthy();
  });
});

/* THE COLUMN THAT EARNS THE TABLE ITS KEEP.
   `HC-PO-2608-001` is in AED_HOUZS as `PO-009968` and nobody saw it for three
   days, because no screen held the two numbers up against each other. */
describe("AutoCountSync — In the book as", () => {
  const inBook = (over: Partial<AcOutboxRow>): AcOutboxRow => row({
    status: "sent", state: "sent", op: "create_so", sent_at: "2026-08-15T01:00:00.000Z", ...over,
  });

  const twoBooked = payload({
    counts: { pending: 0, sent: 2, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 2 },
    rows: [
      inBook({ id: "m", doc_no: "HC-PO-2608-001", doc_type: "PO", op: "create_po",
        ac_doc_no: "PO-009968" }),
      inBook({ id: "q", doc_no: "HC-SO-2608-009", ac_doc_no: "HC-SO-2608-009" }),
    ],
  });

  it("is SILENT when the account book used the number on the paperwork", async () => {
    await mount(twoBooked, "/autocount-sync?state=sent");
    await screen.findAllByText("HC-SO-2608-009");
    const card = cardOf("HC-SO-2608-009");
    expect(card.querySelector("[data-ac-book-flag]")).toBeNull();
  });

  it("is LOUD when AutoCount filed it under a number of its own", async () => {
    await mount(twoBooked, "/autocount-sync?state=sent");
    await screen.findByText("HC-PO-2608-001");
    const card = cardOf("HC-PO-2608-001");
    expect(within(card).getByText("PO-009968")).toBeTruthy();
    expect(within(card).getByText("Different number")).toBeTruthy();
    expect(card.querySelector("[data-ac-book-flag]")).toBeTruthy();
  });

  /* A document already in the account book has nothing to OPEN — that ruling
     does not move — so the flag has to be readable without a click, and the
     sentence spelling it out has to reach the reader some other way. */
  it("flags it without giving the row anything to open", async () => {
    await mount(twoBooked, "/autocount-sync?state=sent");
    await screen.findByText("HC-PO-2608-001");
    const card = cardOf("HC-PO-2608-001");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(card.querySelector("[title*='PO-009968']")).toBeTruthy();
  });

  it("says nothing at all about a document that is not in the book yet", async () => {
    await mount(busy);
    await screen.findByText("SO-P");
    expect(cardOf("SO-P").querySelector("[data-ac-book-flag]")).toBeNull();
  });
});

describe("AutoCountSync — days, the footer and the two lenses", () => {
  const onDay = (id: string, docNo: string, iso: string): AcOutboxRow => row({
    id, doc_no: docNo, status: "sent", state: "sent", op: "create_so",
    ac_doc_no: docNo, created_at: iso, sent_at: iso,
  });

  const threeDays = payload({
    counts: { pending: 0, sent: 3, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 3 },
    rows: [
      onDay("a", "SO-A", "2026-08-15T02:00:00.000Z"),
      onDay("b", "SO-B", "2026-08-14T02:00:00.000Z"),
      onDay("c", "SO-C", "2026-08-14T01:00:00.000Z"),
    ],
  });

  it("breaks the register on the day, once per day and not once per row", async () => {
    await mount(threeDays, "/autocount-sync?state=sent");
    await screen.findAllByText("SO-A");
    expect(document.querySelectorAll("[data-ac-day]").length).toBe(2);
  });

  it("closes the register with how much of the company is on screen", async () => {
    await mount(threeDays, "/autocount-sync?state=sent");
    await screen.findAllByText("SO-A");
    expect(screen.getByText("Showing 1–3 of 3 documents")).toBeTruthy();
    expect(screen.getByText("Sorted by When, newest first")).toBeTruthy();
  });

  /* THE SORT IS A LENS, not a request: pressing it must not re-ask the server,
     which pages by recency and would answer a different question. */
  it("turns the order round without asking the server again", async () => {
    await mount(threeDays, "/autocount-sync?state=sent");
    await screen.findAllByText("SO-A");
    const before = apiGet.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /^When/ }));
    expect(await screen.findByText("Sorted by When, oldest first")).toBeTruthy();
    expect(apiGet.mock.calls.length).toBe(before);
  });

  /* AND SO IS THE DATE RANGE. Both live in the URL on desktop, per CLAUDE.md. */
  it("keeps the date range in the URL and narrows the loaded page only", async () => {
    await mount(threeDays, "/autocount-sync?state=sent");
    await screen.findAllByText("SO-A");
    const before = apiGet.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    /* Every fixture row is dated 2026-08-14/15, so Today empties the register
       — which is the proof the lens is applied at all. */
    expect(await screen.findByText(/Nothing here/)).toBeTruthy();
    expect(apiGet.mock.calls.length).toBe(before);
    for (const call of apiGet.mock.calls) expect(String(call[0])).not.toContain("range");
  });

  it("ignores a hand-edited range or sort rather than emptying the register", async () => {
    await mount(threeDays, "/autocount-sync?state=sent&range=fortnight&sort=sideways");
    await screen.findAllByText("SO-A");
    expect(screen.getByText("Showing 1–3 of 3 documents")).toBeTruthy();
    expect(screen.getByText("Sorted by When, newest first")).toBeTruthy();
  });
});

/* THE KEYLESS ROW'S OWN REPAIR.
 *
 * This screen has told the operator, on every one of these rows, that "the lines
 * have to be matched up against AutoCount, and then the document saved again" —
 * and there was no way to do it (docs/bugs/0585-*). The button is that way, and
 * these pin the two things that make it honest: it is offered ONLY where that
 * refusal is the reason, and it does not pretend the document has been sent.
 */
describe("AutoCountSync — matching a held-back document's lines up", () => {
  /* ITS OWN PAYLOAD, not an extra row on the shared one: four tests above count
     the chips and the per-type totals of `busy` exactly, and a sixth row there
     would make them fail for a reason that has nothing to do with what they
     assert. */
  const keyless = payload({
    rows: [
      row({ id: "kl", doc_no: "SO-KL", doc_type: "SO", op: "edit", status: "skipped", state: "skipped",
        needs_attention: true,
        reason: "refused, nothing sent: 1 of 8 line(s) carry no AutoCount DtlKey",
        reason_kind: "keyless-line", remedy: "backfill linked_ac_dtlkey" }),
      row({ id: "k2", doc_no: "DO-K2", doc_type: "DO", op: "so_to_do", status: "skipped", state: "skipped",
        needs_attention: true,
        reason: "refused, nothing sent (MissingLocationError): line 2 carries no warehouse",
        reason_kind: "missing-location", remedy: "set the warehouse on the line" }),
    ],
    counts: { pending: 0, sent: 0, failed: 0, skipped: 2, requeued: 0, attention: 2, total: 2 },
  });

  it("is offered on the keyless row and on no other", async () => {
    await mount(keyless);
    await screen.findByText("SO-KL");
    expect(within(cardOf("SO-KL")).getByRole("button", { name: "Match up lines" })).toBeTruthy();
    /* A missing warehouse is a different refusal with a different remedy — the
       operator sets the warehouse; there is nothing to match. */
    expect(within(cardOf("DO-K2")).queryByRole("button", { name: "Match up lines" })).toBeNull();
  });

  it("says what it matched, and tells the operator the save is still theirs to do", async () => {
    apiPost.mockResolvedValue({
      ok: true, matched: 1, alreadyKeyed: 7, bookLines: 8, couldNotMatch: [],
      message: "1 line(s) matched up against the account book. Save the document again.",
    });
    await mount(keyless);
    await screen.findByText("SO-KL");
    await userEvent.click(within(cardOf("SO-KL")).getByRole("button", { name: "Match up lines" }));
    expect(await within(cardOf("SO-KL")).findByText(/Save the document again/)).toBeTruthy();
  });

  it("NAMES the lines it could not match rather than counting them", async () => {
    apiPost.mockResolvedValue({
      ok: true, matched: 0, alreadyKeyed: 7, bookLines: 8,
      couldNotMatch: ["'9058-1S' — 2 unclaimed lines in the account book carry that item code"],
      message: "Nothing could be matched — the document is unchanged.",
    });
    await mount(keyless);
    await screen.findByText("SO-KL");
    await userEvent.click(within(cardOf("SO-KL")).getByRole("button", { name: "Match up lines" }));
    expect(await within(cardOf("SO-KL")).findByText(/9058-1S/)).toBeTruthy();
  });
});
