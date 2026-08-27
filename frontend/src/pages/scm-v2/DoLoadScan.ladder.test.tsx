/* THE SCAN SHOWS THE NEXT STEP AND ONLY THE NEXT STEP.
 *
 * Owner, 2026-08-25/26: three scans on one delivery order, each moving it one
 * rung — 「(a) Storekeeper 扫码确认货物装上罗里 (b) 司机出发（IN TRANSIT）(c) 送达
 * （DELIVERED）」 and 「就是我状态只要一点，它基本上都只能剩最后一个状态（下一个
 * 状态）」.
 *
 * These mount the REAL page under a real router at the real URL its QR builds,
 * with only the two data hooks faked, and assert what the person holding the
 * paper SEES and what the button actually PATCHes. Deliberately NOT a unit test
 * over doScanStep: the defect this guards against is a page that ignores the
 * ladder, and calling the helper the page is supposed to call would pass on a
 * page that never calls it. Every assertion below goes through the rendered
 * button.
 *
 * The three ledger entries this change could re-commit, one test each:
 *
 *   0481  a "Mark Signed" button wrote a delivered-counting status and collected
 *         no signature, photo or GPS. Scan ③ writes DELIVERED and collects none
 *         either, so the screen must SAY so before it is pressed.
 *   0480  five surfaces PATCH this endpoint and one sent evidence. This page is
 *         a sixth, so it must state its loss rather than imply a POD.
 *   0530  a status literal that is not a `scm.do_status` member is a 22P02 and a
 *         400, not an empty match. Every target this page can write is checked
 *         against the enum's membership, taken from the shared declaration.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DO_STATUSES } from "../../vendor/shared/do-shipped-states";

const { detail, updateStatus, mutate } = vi.hoisted(() => ({
  detail: vi.fn(),
  updateStatus: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/delivery-order-queries", () => ({
  useMfgDeliveryOrderDetail: detail,
  useUpdateMfgDeliveryOrderStatus: updateStatus,
}));

import { DoLoadScan } from "./DoLoadScan";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Mount the page on a delivery order in the given state. */
const at = (status: string, opts: { onHold?: boolean | null } = {}) => {
  detail.mockReturnValue({
    data: {
      deliveryOrder: {
        id: "do-1",
        do_number: "HC-DO-2608-001",
        debtor_name: "A Customer",
        status,
        city: "Klang",
        state: "Selangor",
        on_hold: opts.onHold ?? null,
      },
      items: [{ id: "i1" }],
    },
    isLoading: false,
    isError: false,
  });
  updateStatus.mockReturnValue({ mutate, isPending: false, isError: false, error: null });
  return render(
    <MemoryRouter initialEntries={["/scm/do-load?id=do-1"]}>
      <DoLoadScan />
    </MemoryRouter>,
  );
};

/** Every button on screen that is not the "open the full DO" link. */
const buttons = () => screen.queryAllByRole("button");

/** Press the one action button and return the body the page tried to PATCH. */
const press = (): { id: string; status: string } => {
  const [only, ...rest] = buttons();
  expect(rest, "the scan must offer exactly one button").toHaveLength(0);
  fireEvent.click(only!);
  expect(mutate).toHaveBeenCalledTimes(1);
  return mutate.mock.calls[0]![0] as { id: string; status: string };
};

/* The ladder as the owner dictated it, read off the SCREEN. The label is what
   he approved in English and the status is what the row must end up holding.

   HAND-TYPED ON PURPOSE, and the lint rule against hand-typed DO status lists is
   disabled here rather than obeyed. That rule exists because ELEVEN copies of
   "which statuses have shipped" drifted apart; this is not a partition of the
   enum, it is the OWNER'S SPEC transcribed — from-state, the English on the
   button, and what the row must end up holding. Deriving it from
   DO_STATUSES would make the test assert the code against itself, which is the
   decorative-test failure this file was written to avoid. Membership of the enum
   IS checked, separately and from the shared constant, in the 0530 block below. */
/* eslint-disable no-restricted-syntax -- the owner's spec, not a partition of do_status; see above */
const LADDER: Array<[from: string, label: string, writes: string]> = [
  ["DRAFT", "Confirm loading", "LOADED"],
  ["LOADED", "Confirm Loaded", "DISPATCHED"],
  ["DISPATCHED", "Confirm Departure", "IN_TRANSIT"],
  ["IN_TRANSIT", "Confirm Delivered", "DELIVERED"],
];
/* eslint-enable no-restricted-syntax */

describe("the scan offers the next step, and only the next step", () => {
  it.each(LADDER)("%s offers %s and writes %s", (from, label, writes) => {
    at(from);
    expect(screen.getByRole("button").textContent).toContain(label);
    expect(press()).toEqual({ id: "do-1", status: writes });
  });

  /* THE "只能剩最后一个状态" RULE, asserted as an absence rather than a presence.
     A page that rendered the whole ladder would pass every test above and still
     let a storekeeper mark a delivery delivered from the dock. */
  it.each(LADDER)("%s offers no other rung's words", (from, label) => {
    at(from);
    const shown = buttons().map((b) => b.textContent);
    expect(shown).toHaveLength(1);
    for (const [, otherLabel] of LADDER) {
      if (otherLabel === label) continue;
      expect(shown[0]).not.toContain(otherLabel);
    }
  });

  /* No going back: nothing on this page can write a status EARLIER than the one
     the document already holds. The server refuses a shipped→pre-ship move
     (`illegal_status_transition`) but accepts every lateral and backward move
     within the shipped states, so this is the client's own rule and nothing
     else enforces it. */
  it("never writes a rung the document has already passed", () => {
    // eslint-disable-next-line no-restricted-syntax -- an ORDERING, not a set: DO_STATUSES carries no rung order
    const order = ["DRAFT", "LOADED", "DISPATCHED", "IN_TRANSIT", "DELIVERED"];
    for (const [from, , writes] of LADDER) {
      expect(order.indexOf(writes)).toBe(order.indexOf(from) + 1);
    }
  });
});

describe("the scan refuses, out loud, where there is no step", () => {
  it.each([
    ["DELIVERED", "Nothing left to do on this document."],
    ["INVOICED", "Nothing left to do on this document."],
    /* SIGNED is a real enum member that counts as delivered everywhere
       (doCountsAsDelivered), so a row still carrying it is finished, not
       unexpected. Nothing writes it any more — see the SIGNED test below. */
    ["SIGNED", "Nothing left to do on this document."],
  ])("%s says: %s", (status, sentence) => {
    at(status);
    expect(buttons()).toHaveLength(0);
    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it("CANCELLED refuses clearly and sends them to the office", () => {
    at("CANCELLED");
    expect(buttons()).toHaveLength(0);
    expect(screen.getByText(/cancelled/i).textContent).toMatch(/call the office/i);
  });

  it("a held delivery order offers nothing, on any rung", () => {
    for (const [from] of LADDER) {
      at(from, { onHold: true });
      expect(buttons(), `held on ${from}`).toHaveLength(0);
      expect(screen.getByText(/on hold/i)).toBeTruthy();
      cleanup();
    }
  });

  /* Never silent — the standing rule this module's own header states. A status
     nobody planned for still gets a sentence rather than a blank card. */
  it("an unrecognised status says so instead of showing nothing", () => {
    at("COMPLETED");
    expect(buttons()).toHaveLength(0);
    expect(screen.getByText(/unexpected state/i)).toBeTruthy();
  });
});

describe("bug 0481 / 0480 — the delivered scan admits what it does not collect", () => {
  /* 0481's sentence: "the status is literally named for the evidence it does not
     collect". This page collects none of the three, so the words beside the
     button have to name all three losses AND name the screen that does capture
     them, or it is that button again behind a QR code. */
  it("names the signature, the photo and the location it does not take", () => {
    at("IN_TRANSIT");
    const note = screen.getByText(/not a signed receipt/i).textContent;
    expect(note).toMatch(/signature/i);
    expect(note).toMatch(/photo/i);
    expect(note).toMatch(/location/i);
    expect(note, "0480: name the remedy that DOES exist").toMatch(/proof of delivery/i);
  });

  /* 0480's second half: the planning board promised a remedy that did not
     exist. The other three rungs are not deliveries, so they must NOT carry
     this disclaimer — a warning on every screen is a warning nobody reads. */
  it.each([["DRAFT"], ["LOADED"], ["DISPATCHED"]])(
    "%s does not claim anything about proof of delivery",
    (from) => {
      at(from);
      expect(screen.queryByText(/signed receipt/i)).toBeNull();
    },
  );

  /* The page sends a bare status and no evidence keys — the third assertion in
     do-status-evidence.test.tsx, restated from this caller: a status change must
     never blank a POD already on the row. */
  it("sends the status alone, never an empty evidence field", () => {
    at("IN_TRANSIT");
    expect(press()).toEqual({ id: "do-1", status: "DELIVERED" });
  });
});

describe("bug 0530 — every status this page can write is a real do_status member", () => {
  it("writes only labels the enum defines", () => {
    for (const [from, , writes] of LADDER) {
      at(from);
      const sent = press();
      expect(DO_STATUSES as readonly string[], `${from} writes ${sent.status}`)
        .toContain(sent.status);
      cleanup();
      vi.clearAllMocks();
    }
  });

  /* SIGNED IS NEVER PRODUCED. It is a legal enum member and it counts as
     delivered, which is exactly why a bare button writing it was bug 0481.
     Nothing has written it since 2026-08-21 and this ladder does not reopen
     that: sweep every member of the enum through the page and prove no press
     ever sends it. */
  it("no status anywhere in the enum leads to a scan that writes SIGNED", () => {
    for (const status of DO_STATUSES) {
      at(status);
      for (const b of buttons()) fireEvent.click(b);
      cleanup();
    }
    const written = mutate.mock.calls.map((c) => (c[0] as { status: string }).status);
    expect(written).not.toContain("SIGNED");
  });
});

describe("one scan is one step", () => {
  it("shows a confirmation and no button after a rung is written", () => {
    at("LOADED");
    const [button] = buttons();
    /* Run the caller's own onSuccess, which is what a resolved PATCH does. */
    fireEvent.click(button!);
    const [, opts] = mutate.mock.calls[0] as [unknown, { onSuccess: () => void }];
    act(() => opts.onSuccess());
    expect(buttons(), "a second rung must need a second scan").toHaveLength(0);
    expect(screen.getByText(/loaded onto the lorry/i)).toBeTruthy();
  });
});
