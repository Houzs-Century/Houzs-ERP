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

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost } }));

import { MobileAutoCountSync } from "./MobileAutoCountSync";
import {
  AC_REASON_COPY,
  acHeadline,
  type AcOutboxResponse,
  type AcOutboxRow,
} from "../lib/autocountOutbox";

afterEach(cleanup);
/* Braces, not a concise arrow — see the comment in pages/autoCountSync.test.tsx
   and the BUG-HISTORY entry. A returned mock becomes vitest's teardown. */
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

/* `data-ac-row`, not `.card`: the list is windowed now and the windowing
   component owns the element wrapping each card. */
const cardOf = (docNo: string) =>
  screen.getByText(docNo).closest("[data-ac-row]") as HTMLElement;

/** Open a card by its always-visible reason line — the line IS the opener. */
async function openRow(docNo: string) {
  await userEvent.click(within(cardOf(docNo)).getAllByRole("button", { expanded: false })[0]!);
  return cardOf(docNo);
}

/**
 * A card's text WITHOUT the collapsed technical block. jsdom applies no
 * user-agent stylesheet, so a closed `<details>` still contributes everything it
 * holds to `textContent` — "not on screen" has to be asked structurally. Same
 * helper, same reasoning, as the desktop suite.
 */
const plainTextOf = (el: HTMLElement): string => {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of copy.querySelectorAll("[data-ac-technical]")) n.remove();
  return copy.textContent;
};

async function openReplacedGroup() {
  await userEvent.click(
    screen.getByRole("button", { name: /replaced documents?, kept as a record/ }),
  );
}

const busy = payload({
  counts: { pending: 1, sent: 1, failed: 1, skipped: 1, requeued: 1, attention: 2, total: 5 },
  rows: [
    row({ id: "f", doc_no: "SO-F", doc_type: "SO", status: "failed", state: "failed", attempts: 6,
      needs_attention: true, can_requeue: true,
      reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
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

  it("surfaces a switched-off sync in the headline", async () => {
    const off = payload({ writeback: { value: "On ", on: false, scope: "off" } });
    await mount(off);
    /* The dedicated switch line was removed in the 2026-08-21 declutter; the
       headline still carries the off status, which is the one that matters. */
    expect(await screen.findByText(acHeadline(off).text)).toBeTruthy();
  });

  it("carries BOTH filter strips, each chip with its count", async () => {
    await mount(busy);
    /* Four status tabs now (owner 2026-08-21). "Not accepted" is the merged
       stuck bucket = attention (failed 1 + skipped 1 = 2). */
    expect(await screen.findByRole("button", { name: /All\s*5/ })).toBeTruthy();
    expect(chip(/Waiting\s*1/)).toBeTruthy();
    expect(chip(/Not accepted\s*2/)).toBeTruthy();
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
    await userEvent.click(await screen.findByRole("button", { name: /Not accepted\s*2/ }));
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=attention");
  });
});

describe("MobileAutoCountSync — the reason is on the row here too", () => {
  /* The headline is on the card with no click — the same rule the desktop page
     follows, and the one the owner rejected an earlier design for breaking. */
  it("shows the same headline the desktop page shows, before any click", async () => {
    await mount(busy);
    const copy = AC_REASON_COPY["missing-location"]!;
    expect(await screen.findByText(copy.headline)).toBeTruthy();
    expect(screen.queryByText(copy.explain)).toBeNull();
    expect(screen.queryByText("To fix")).toBeNull();
  });

  it("puts the same rest of it behind opening the card", async () => {
    await mount(busy);
    const copy = AC_REASON_COPY["missing-location"]!;
    await screen.findByText("DO-K");
    const card = await openRow("DO-K");
    expect(within(card).getByText(copy.explain)).toBeTruthy();
    expect(within(card).getByText("To fix")).toBeTruthy();
    expect(within(card).getByText(new RegExp(copy.toFix.slice(0, 30)))).toBeTruthy();
  });

  it("makes the same distinction about who was asked", async () => {
    await mount(busy);
    await screen.findByText("DO-K");
    const card = await openRow("DO-K");
    expect(within(card).getByText("AutoCount was not asked")).toBeTruthy();
    const failed = await openRow("SO-F");
    expect(within(failed).getByText("AutoCount replied")).toBeTruthy();
    expect(within(failed).getByText(/FK_SO_SalesAgent/)).toBeTruthy();
  });

  /* Behind the fold since 2026-08-16, on this surface too — see the replaced
     block at the bottom of this file. Everything it says is unchanged, except
     the words, which no longer read as an order to press Send again. */
  it("marks a replaced refusal as a record, not an open item", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    await openReplacedGroup();
    expect(within(cardOf("IV-R")).getByText("Replaced")).toBeTruthy();
    expect(
      within(cardOf("IV-R")).getByText(/Replaced by a newer send — nothing to do on this one/),
    ).toBeTruthy();
    const card = await openRow("IV-R");
    expect(within(card).getByText(/record of the first refusal/i)).toBeTruthy();
    expect(within(card).queryByText("To fix")).toBeNull();
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

/* Send again exists on BOTH surfaces or the pairing is broken. A control on the
   desktop page and not the phone is the recurring bug class this repo names. */
describe("MobileAutoCountSync — Send again", () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    accepted: true,
    code: "requeued",
    message: "Sent back to the queue. It goes to AutoCount on the next five-minute sweep.",
    row_id: "f", doc_type: "SO", doc_no: "SO-F", op: "create_so",
    new_row_id: "ob-9", reason: null,
    ...over,
  });

  it("offers the button on the same rows the desktop page offers it on", async () => {
    await mount(busy);
    await screen.findByText("SO-F");
    const offered = cardOf("SO-F");
    expect(within(offered).getByRole("button", { name: "Send again" })).toBeTruthy();
    const notOffered = cardOf("DO-K");
    expect(within(notOffered).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("says so on the row when the document is on its way again", async () => {
    apiPost.mockResolvedValue(answer());
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(apiPost).toHaveBeenCalledWith("/api/scm/autocount-outbox/f/requeue");
    expect(await screen.findByText(/Sent back to the queue/)).toBeTruthy();
  });

  it("prints a refusal rather than letting the press look like nothing", async () => {
    apiPost.mockResolvedValue(answer({
      accepted: false, code: "already-sent", new_row_id: null,
      message: "AutoCount already accepted this one.",
    }));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText(/AutoCount already accepted this one/)).toBeTruthy();
  });

  it("says the call never got through, rather than swallowing the throw", async () => {
    apiPost.mockRejectedValue(new Error("the worker is unreachable"));
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: "Send again" }));
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy();
  });
});

describe("MobileAutoCountSync — an accepted re-send stops giving orders about the old refusal", () => {
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
    expect(within(after).queryByText("To fix")).toBeNull();
    expect(within(after).queryByText("AutoCount replied")).toBeNull();
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

/* The same four things the desktop page's last describe block guards, asserted
   here because desktop and mobile are one product and a simplification landing
   on one surface only is the recurring bug class this repo names. */
describe("MobileAutoCountSync — a thousand documents", () => {
  const manyRows = (n: number): AcOutboxRow[] =>
    Array.from({ length: n }, (_, i) => row({
      id: `x${i}`, doc_no: `SO-${i}`, status: "sent", state: "sent",
      ac_doc_no: `AC-${i}`, sent_at: "2026-08-15T01:00:00.000Z",
    }));

  it("opens on the documents that need attention, not on everything", async () => {
    await mount(busy);
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox?state=attention");
  });

  it("keeps everything one click away", async () => {
    await mount(busy);
    await userEvent.click(await screen.findByRole("button", { name: /All\s*5/ }));
    expect(apiGet).toHaveBeenCalledWith("/api/scm/autocount-outbox");
  });

  it("gives a document already in AutoCount one card and nothing to open", async () => {
    await mount(payload({
      rows: [row({ id: "s", doc_no: "GR-S", doc_type: "GR", op: "po_to_gr", status: "sent",
        state: "sent", ac_doc_no: "GR-00123", sent_at: "2026-08-15T01:00:00.000Z" })],
      counts: { pending: 0, sent: 1, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 1 },
    }));
    await screen.findByText("GR-S");
    const card = cardOf("GR-S");
    expect(within(card).queryByRole("button", { expanded: false })).toBeNull();
    expect(within(card).queryByRole("button", { expanded: true })).toBeNull();
    expect(within(card).getByText(/In the account book as GR-00123/)).toBeTruthy();
  });

  it("does not put several hundred cards into the page at once", async () => {
    await mount(payload({
      rows: manyRows(400),
      counts: { pending: 0, sent: 400, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 400 },
    }));
    await screen.findByText("SO-0");
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
   THE FOUR THINGS THE OWNER READ OFF THE LIVE PAGE ON 2026-08-16, on the phone.

   Every one of them is a rule in lib/autocountOutbox, so what these assert is
   that this surface RENDERS the rule rather than carrying its own version of
   it. A fix landing on the desktop only is the bug class this repo names most
   often, and a 375 px screen is where a wall of machinery costs most.
   ─────────────────────────────────────────────────────────────────────────── */
describe("MobileAutoCountSync — the same four fixes, one surface over", () => {
  const PARENTLESS =
    "created with no source delivery order, so there is no source document to transfer from. "
    + "AutoCount builds a DO / GRN / Invoice only by transferring a source document's lines "
    + "(AddPartialTransferDetail is the SDK's only primitive), so this document cannot be "
    + "created in the account book at all and will stay ERP-only.";

  const WITH_DUMP =
    "Gave up after 6 attempts. Last error: Invalid transfer item. || source SO lines as the book "
    + "holds them: 905348 on SO HC-SO-2608-002 [AK-ULTIMATE MATT (K)] Qty=1.00000000 "
    + "TransferedQty=0.00000000 Transferable=T docCancelled=F outstanding=1.00000000";

  const both = payload({
    counts: { pending: 0, sent: 0, failed: 1, skipped: 1, requeued: 0, attention: 2, total: 2 },
    rows: [
      row({ id: "iv", doc_no: "HC-IV-2608-004", doc_type: "IV", op: "do_to_iv",
        status: "skipped", state: "skipped", needs_attention: true,
        reason_kind: "no-source-document", reason: PARENTLESS }),
      row({ id: "do2", doc_no: "HC-DO-2608-002", doc_type: "DO", op: "so_to_do",
        status: "failed", state: "failed", attempts: 6, needs_attention: true,
        can_requeue: true, reason: WITH_DUMP }),
    ],
  });

  it("prints no SDK method name, and keeps the note behind the disclosure", async () => {
    await mount(both);
    await screen.findByText("HC-IV-2608-004");
    const card = await openRow("HC-IV-2608-004");
    expect(plainTextOf(card)).not.toContain("AddPartialTransferDetail");
    expect(card.querySelector("[data-ac-technical]")?.textContent)
      .toContain("AddPartialTransferDetail");
    /* The distinction he asked for by name is untouched. */
    expect(within(card).getByText("AutoCount was not asked")).toBeTruthy();
  });

  it("keeps AutoCount's own sentence and folds the account-book dump", async () => {
    await mount(both);
    await screen.findByText("HC-DO-2608-002");
    const card = await openRow("HC-DO-2608-002");
    expect(within(card).getByText(/Invalid transfer item\./)).toBeTruthy();
    expect(plainTextOf(card)).not.toContain("TransferedQty");
    expect(card.querySelector("[data-ac-technical]")?.textContent).toContain("905348");
  });

  it("does not order a fix for a field AutoCount never named", async () => {
    await mount(both);
    await screen.findByText("HC-DO-2608-002");
    const card = await openRow("HC-DO-2608-002");
    expect(within(card).queryByText(/Put right whatever AutoCount named/)).toBeNull();
    expect(within(card).getByText(/Pass it to whoever looks after the AutoCount link/))
      .toBeTruthy();
  });

  it("folds replaced documents out of the list, and shows them when asked", async () => {
    const withHistory = payload({
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 2, attention: 1, total: 3 },
      rows: [
        row({ id: "live", doc_no: "HC-DO-2608-100", status: "failed", state: "failed",
          needs_attention: true, reason: "Gave up after 6 attempts. Last error: Invalid transfer item." }),
        row({ id: "h1", doc_no: "HC-DO-2608-001", status: "skipped", state: "requeued",
          reason: "[re-queued …] refused" }),
        row({ id: "h2", doc_no: "HC-DO-2608-002", status: "skipped", state: "requeued",
          reason: "[re-queued …] refused" }),
      ],
    });
    await mount(withHistory);
    await screen.findByText("HC-DO-2608-100");
    expect(document.querySelectorAll("[data-ac-row]").length).toBe(1);

    await openReplacedGroup();

    expect(document.querySelectorAll("[data-ac-row]").length).toBe(3);
    expect(screen.getByText(/nothing here to do/i)).toBeTruthy();
  });

  it("says its own sentence about a load failure, and quotes the transport under it", async () => {
    await mount(new Error("AutoCount service responded 502"));
    expect(await screen.findByText(
      "The queue could not be read, so nothing below is the current picture.",
    )).toBeTruthy();
    expect(screen.getByText("AutoCount service responded 502")).toBeTruthy();
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   ONE DOCUMENT, ONE CARD — the phone half of the owner's duplicate report.

   "为什么在 AutoCount 里面一张 Sales Order 会出现两次呢?" He read it on the
   desktop; a phone has LESS room for the same sales order four times over, not
   more, and a fix on one surface only is the bug class this repo names.
   ─────────────────────────────────────────────────────────────────────────── */
describe("MobileAutoCountSync — one document, one card", () => {
  const sent = (over: Partial<AcOutboxRow>): AcOutboxRow =>
    row({ status: "sent", state: "sent", ac_doc_no: "SO-00002", ...over });

  const hisScreen = payload({
    counts: { pending: 0, sent: 2, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 2 },
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
    ],
  });

  it("renders one sales order once, however many times it was sent", async () => {
    await mount(hisScreen);
    /* The phone opens on Needs attention, as the desktop does — these five are
       all in AutoCount, so the chip is how they are reached. */
    await userEvent.click(await screen.findByRole("button", { name: /In AutoCount\s*2/ }));
    await screen.findAllByText("HC-SO-2608-002");
    expect(document.querySelectorAll("[data-ac-row]").length).toBe(2);
    expect(screen.getAllByText("HC-SO-2608-002")).toHaveLength(1);
  });

  it("counts documents on both strips and in the line under them", async () => {
    await mount(hisScreen);
    await userEvent.click(await screen.findByRole("button", { name: /In AutoCount\s*2/ }));
    await screen.findAllByText("HC-SO-2608-002");
    expect(screen.getByText("2 of 2 documents")).toBeTruthy();
    expect(chip(/Sales orders\s*2/)).toBeTruthy();
  });

  it("keeps every send, one tap under the document", async () => {
    await mount(hisScreen);
    await userEvent.click(await screen.findByRole("button", { name: /In AutoCount\s*2/ }));
    await screen.findAllByText("HC-SO-2608-002");
    const card = cardOf("HC-SO-2608-002");
    expect(card.querySelectorAll("[data-ac-send]").length).toBe(0);
    await userEvent.click(
      within(card).getByRole("button", { name: /3 earlier sends for this document/ }),
    );
    expect(cardOf("HC-SO-2608-002").querySelectorAll("[data-ac-send]").length).toBe(3);
  });

  it("says the numbers are a floor when the server could not scan the whole queue", async () => {
    await mount(payload({
      counts_complete: false,
      rows: [row({ status: "failed", state: "failed", needs_attention: true, reason: "refused" })],
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    }));
    expect(await screen.findByText(/at least this many and possibly more/)).toBeTruthy();
  });
});

/* SEND NOW, one surface over. A control on the desktop and not the phone is the
   recurring bug class this repo names, and the owner uses the phone on the
   floor — a document that has to go out NOW is exactly the case he is standing
   in front of when he wants it. */
describe("MobileAutoCountSync — Send now", () => {
  /* ITS OWN PAYLOAD, not a row bolted onto `busy`. The shared fixture's counts
     are asserted verbatim by the filter-strip test one describe up, so adding a
     row to it fails a test that has nothing to do with this button. A fixture
     shared by thirty assertions is not a free place to put a thirty-first. */
  const waiting = payload({
    counts: { pending: 1, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 1 },
    rows: [
      row({ id: "p", doc_no: "SO-P", doc_type: "SO", status: "pending", state: "pending",
        attempts: 2, can_send_now: true,
        reason: "AcSyncService threw: timeout opening the book" }),
      row({ id: "f", doc_no: "SO-F", doc_type: "SO", status: "failed", state: "failed",
        attempts: 6, needs_attention: true, can_requeue: true,
        reason: "Gave up after 6 attempts. Last error: FK_SO_SalesAgent" }),
    ],
  });

  const answer = (over: Record<string, unknown> = {}) => ({
    accepted: true,
    code: "sent-now",
    message: "Sent, and AutoCount took it. It is in the account book now — you did not have to wait for the five-minute sweep.",
    row_id: "p", doc_type: "SO", doc_no: "SO-P", op: "create_so",
    new_row_id: null, reason: null,
    ...over,
  });

  it("offers it on the same rows the desktop page offers it on", async () => {
    await mount(waiting);
    await screen.findByText("SO-P");
    expect(within(cardOf("SO-P")).getByRole("button", { name: "Send now" })).toBeTruthy();
    /* And never beside Send again: the two server predicates are disjoint. */
    expect(within(cardOf("SO-F")).queryByRole("button", { name: "Send now" })).toBeNull();
    expect(within(cardOf("SO-P")).queryByRole("button", { name: "Send again" })).toBeNull();
  });

  it("pushes that row and says the account book took it", async () => {
    apiPost.mockResolvedValue(answer());
    await mount(waiting);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(apiPost).toHaveBeenCalledWith("/api/scm/autocount-outbox/p/send-now");
    expect(await screen.findByText(/in the account book now/i)).toBeTruthy();
  });

  it("prints a refusal rather than letting the press look like nothing", async () => {
    apiPost.mockResolvedValue(answer({
      accepted: false, code: "already-in-flight",
      message: "It is going out right now — either the five-minute sweep picked it up, or somebody else pressed this a moment ago. Nothing was sent twice.",
    }));
    await mount(waiting);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(await screen.findByText(/Nothing was sent twice/i)).toBeTruthy();
  });

  it("says the call never got through, rather than swallowing the throw", async () => {
    apiPost.mockRejectedValue(new Error("the worker is unreachable"));
    await mount(waiting);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy();
  });

  /* THE SAME SENTENCES AS THE DESKTOP, and asserted here rather than assumed:
     both screens read `note.ancestors`, which `acAncestorLine` words once, so a
     wording that drifted would have to break this test to do it. #0552. */
  it("names every ancestor the press sent, and why each had to go first", async () => {
    apiPost.mockResolvedValue(answer({
      ancestors_sent: [
        { doc_type: "SO", doc_no: "SO-A", code: "sent", reason: "stale" },
        { doc_type: "DO", doc_no: "DO-B", code: "sent", reason: "missing" },
      ],
    }));
    await mount(waiting);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(await screen.findByText(/SO-A — AutoCount had an older version, sent\./)).toBeTruthy();
    expect(screen.getByText(/DO-B — AutoCount did not have it yet, sent\./)).toBeTruthy();
  });

  it("shows an ancestor that failed, not only the ones that worked", async () => {
    apiPost.mockResolvedValue(answer({
      ancestors_sent: [{ doc_type: "SO", doc_no: "SO-A", code: "still-refused", reason: "missing" }],
    }));
    await mount(waiting);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    expect(await screen.findByText(/SO-A .*not sent — still-refused/)).toBeTruthy();
  });

  it("says nothing about ancestors when the press moved none", async () => {
    apiPost.mockResolvedValue(answer({ ancestors_sent: [] }));
    await mount(waiting);
    await userEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await screen.findByText(/in the account book now/i);
    expect(screen.queryByText(/Sent first/i)).toBeNull();
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   WHAT CROSSED OVER FROM THE 2026-08-21 REGISTER, AND WHAT DID NOT.

   The desktop became an eight-column table; this screen kept its cards, because
   a table does not fit 375 px. That is a PRESENTATION difference and it is
   allowed. What is not allowed is a VERDICT or a CONTROL living on one surface
   only — the recurring bug class this repo names — so the mismatch flag, the day
   buckets, the date range and the closing line all had to come with it, from the
   same helpers in lib/autocountRegister.
   ─────────────────────────────────────────────────────────────────────────── */
describe("MobileAutoCountSync — the register's verdicts, on a phone", () => {
  const booked = (over: Partial<AcOutboxRow>): AcOutboxRow => row({
    status: "sent", state: "sent", sent_at: "2026-08-15T01:00:00.000Z", ...over,
  });

  const twoBooked = payload({
    counts: { pending: 0, sent: 2, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 2 },
    rows: [
      booked({ id: "m", doc_no: "HC-PO-2608-001", doc_type: "PO", op: "create_po",
        ac_doc_no: "PO-009968" }),
      booked({ id: "q", doc_no: "HC-SO-2608-009", ac_doc_no: "HC-SO-2608-009" }),
    ],
  });

  /* THE OWNER USES THIS SCREEN ON THE FLOOR. A flag he only gets at his desk is
     a flag he does not get, and this one went three days unseen already. */
  it("flags a document the account book filed under its own number", async () => {
    await mount(twoBooked);
    await userEvent.click(chip(/In AutoCount/));
    await screen.findByText("HC-PO-2608-001");
    const card = cardOf("HC-PO-2608-001");
    expect(within(card).getByText("Different number")).toBeTruthy();
    /* A phone has no hover, so the sentence is ON the card, not in a title. */
    expect(within(card).getAllByText(/PO-009968/).length).toBeGreaterThan(0);
  });

  it("says nothing when the book used the number on the paperwork", async () => {
    await mount(twoBooked);
    await userEvent.click(chip(/In AutoCount/));
    await screen.findByText("HC-SO-2608-009");
    expect(cardOf("HC-SO-2608-009").querySelector("[data-ac-book-flag]")).toBeNull();
  });

  /* A document already in the account book has nothing to OPEN — the ruling is
     the same on both surfaces, and the flag must not smuggle an opener in. */
  it("flags it without giving the card anything to open", async () => {
    await mount(twoBooked);
    await userEvent.click(chip(/In AutoCount/));
    await screen.findByText("HC-PO-2608-001");
    expect(within(cardOf("HC-PO-2608-001")).queryByRole("button")).toBeNull();
  });

  it("breaks the cards on the day, and closes the list with what is on screen", async () => {
    await mount(payload({
      counts: { pending: 0, sent: 3, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 3 },
      rows: [
        booked({ id: "a", doc_no: "SO-A", ac_doc_no: "SO-A", created_at: "2026-08-15T02:00:00.000Z", sent_at: "2026-08-15T02:00:00.000Z" }),
        booked({ id: "b", doc_no: "SO-B", ac_doc_no: "SO-B", created_at: "2026-08-14T02:00:00.000Z", sent_at: "2026-08-14T02:00:00.000Z" }),
        booked({ id: "c", doc_no: "SO-C", ac_doc_no: "SO-C", created_at: "2026-08-14T01:00:00.000Z", sent_at: "2026-08-14T01:00:00.000Z" }),
      ],
    }));
    await userEvent.click(chip(/In AutoCount/));
    await screen.findAllByText("SO-A");
    expect(document.querySelectorAll("[data-ac-day]").length).toBe(2);
    expect(screen.getByText("Showing 1–3 of 3 documents")).toBeTruthy();
  });

  /* THE DATE RANGE IS A FILTER, and a filter on one surface only is the split
     the shared layer exists to stop. It is component state here — the mobile
     shell has no router — so what proves it works is the list changing without
     the server being asked again. */
  it("carries the date range the desktop has, and applies it without a refetch", async () => {
    await mount(twoBooked);
    await userEvent.click(chip(/In AutoCount/));
    await screen.findByText("HC-PO-2608-001");
    const before = apiGet.mock.calls.length;
    await userEvent.click(chip(/^Today$/));
    expect(await screen.findByText(/Nothing here/)).toBeTruthy();
    expect(apiGet.mock.calls.length).toBe(before);
  });

  it("turns the order round on the phone too", async () => {
    await mount(twoBooked);
    await userEvent.click(chip(/In AutoCount/));
    await screen.findByText("HC-PO-2608-001");
    await userEvent.click(chip(/Newest first/));
    expect(await screen.findByText("Oldest first")).toBeTruthy();
  });
});
