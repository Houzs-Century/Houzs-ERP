/* THE NO-LOGIN SCAN PAGE, MOUNTED AND PRESSED.
 *
 * Owner: 「就跟hookka一样」 — the driver scans the paper with a phone camera and
 * the page opens with no sign-in. The 64-hex token in the URL is the only
 * credential.
 *
 * These mount the REAL page and assert what the person holding the paper SEES
 * and what the button actually POSTs. Deliberately not a unit test over the
 * ladder — DoLoadScan.ladder.test.tsx already covers that for the authed twin,
 * and the defect THIS page could carry is different in kind: it is the only
 * delivery-closing surface with nobody logged in behind it, so what it shows
 * and what it withholds is the whole risk.
 *
 * Three properties, each traceable to a ledger entry or to the owner's ruling:
 *
 *   0481  a status button that collects no evidence must SAY so before it is
 *         pressed. Scan ③ writes DELIVERED and captures no signature, photo or
 *         location; the note under the button names that loss.
 *   0480  this is the sixth path that closes a delivery. It states its loss
 *         rather than growing a second proof-of-delivery capture.
 *   the token IS the credential — a page that showed a price, a street address
 *         or a phone number would be handing them to anyone who finds the paper.
 */
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublicDoScan } from "./PublicDoScan";

const TOKEN = "a".repeat(64);

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", `/d/${TOKEN}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  }));

/** Serve the summary the server would build for a delivery order in `status`. */
function serve(summary: Record<string, unknown>, advanceBody?: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json(advanceBody ?? { outcome: "DONE", doNumber: "HC-DO-2608-001", from: "LOADED", to: "DISPATCHED", message: "Recorded as loaded onto the lorry." })
      : json(summary));
}

const LOADED = {
  kind: "do",
  doNumber: "HC-DO-2608-001",
  customerName: "A Customer",
  area: "Klang, Selangor",
  itemCount: 2,
  status: "LOADED",
  step: {
    status: "DISPATCHED",
    label: "Confirm Loaded",
    note: "Press this once every item on this delivery order is on the lorry. Stock is not touched — it left when the delivery order was confirmed.",
  },
  blockReason: null,
};

const mount = async () => {
  await act(async () => { render(<PublicDoScan />); });
};

describe("the page a driver opens with no account", () => {
  it("shows the document, its area and its line count — and the ONE next rung", async () => {
    serve(LOADED);
    await mount();
    expect(screen.getByText("HC-DO-2608-001")).toBeTruthy();
    expect(screen.getByText("A Customer")).toBeTruthy();
    expect(screen.getByText(/Klang, Selangor/)).toBeTruthy();
    expect(screen.getByText(/2 lines/)).toBeTruthy();
    /* DISPATCHED reads "Loaded" everywhere in this system (status-pill.ts), and
       the page renders the label, never the enum key. */
    expect(screen.getByText(/Confirmed/)).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toContain("Confirm Loaded");
  });

  it("POSTs the rung it was SHOWN, and never a status it chose", async () => {
    serve(LOADED);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(String(post[0])).toContain(`/api/public/do-scan/${TOKEN}/advance`);
    expect(JSON.parse(String(post[1].body))).toEqual({ to: "DISPATCHED" });
  });

  it("one scan is one step — the button is gone after it is pressed", async () => {
    serve(LOADED);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText(/Recorded as loaded onto the lorry/)).toBeTruthy();
  });

  it("a repeat scan reads as already-done, not as an error", async () => {
    serve(LOADED, {
      outcome: "ALREADY_DONE", doNumber: "HC-DO-2608-001", from: "DISPATCHED",
      message: "Recorded as loaded onto the lorry. The driver scans again when the lorry leaves.",
    });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText(/scans again when the lorry leaves/)).toBeTruthy();
  });
});

describe("what it refuses to say", () => {
  it("an unknown or revoked token gets one screen, with no hint the code was real", async () => {
    fetchMock.mockImplementation(() =>
      json({ error: "unknown_token", message: "Unknown or expired QR code. Please ask the office for a freshly printed delivery order." }, 404));
    await mount();
    expect(screen.getByText("Unknown or expired QR code")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    const seen = String(document.body.textContent).toLowerCase();
    for (const leak of ["revoked", "cancelled", "expired link", "was valid"]) {
      expect(seen).not.toContain(leak);
    }
  });

  it("a 503 reads as \"could not reach\", not as a dead code", async () => {
    /* A driver must not be sent back to the office over a database hiccup. */
    fetchMock.mockImplementation(() =>
      json({ error: "scan_unavailable", message: "We could not reach this delivery order just now. Wait a moment and scan again." }, 503));
    await mount();
    expect(screen.getByText("Could not reach the system")).toBeTruthy();
    expect(screen.queryByText("Unknown or expired QR code")).toBeNull();
  });

  it("names what Confirm Delivered does NOT collect, before it is pressed — bug 0481", async () => {
    serve({
      ...LOADED,
      status: "IN_TRANSIT",
      step: {
        status: "DELIVERED",
        label: "Confirm Delivered",
        note: "This records that the driver reported the goods as delivered. It is not a signed receipt — no customer signature, no photo and no location are captured here. Use Proof of Delivery in the Delivery app when the customer signs.",
      },
    });
    await mount();
    const body = document.body.textContent;
    expect(screen.getByRole("button").textContent).toContain("Confirm Delivered");
    expect(body).toContain("not a signed receipt");
    expect(body).toContain("Proof of Delivery");
  });

  /* An unanswered count must not render as an empty lorry. "0 lines" is a claim
     about the load; a dash is a report of what we know. */
  it("says the line count is unavailable rather than printing 0", async () => {
    serve({ ...LOADED, itemCount: null });
    await mount();
    expect(screen.getByText(/line count unavailable/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("0 lines");
  });

  it("a held delivery order gets a sentence and no button at all", async () => {
    serve({
      ...LOADED,
      step: null,
      blockReason: "This delivery order is on hold, so it must not move. Call the office before putting anything on or off the lorry.",
    });
    await mount();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/must not move/)).toBeTruthy();
  });

  it("renders no money, no street address and no phone number — the source cannot", async () => {
    serve(LOADED);
    await mount();
    const body = document.body.textContent;
    expect(body).not.toMatch(/RM\s?\d/);
    expect(body).not.toMatch(/\+?60\d{6,}/);
    expect(body).not.toMatch(/\b\d{5}\b/); // a Malaysian postcode
  });
});

/* THE PACKING LIST — one sheet, the whole run.
 *
 * The page must show the driver, BEFORE he presses, what the scan is about to
 * touch and what it cannot; and AFTER he presses, what happened to each drop.
 * "3 of 5 recorded" without naming the two is worse than saying nothing,
 * because he has to re-scan the run to find out which. */
const RUN = {
  kind: "trip",
  tripNo: "TRIP-2608-001",
  tripDate: "2026-08-26",
  status: "PLANNED",
  step: { status: "DISPATCHED", label: "Confirm Loaded", note: "Press this once every item is on the lorry." },
  blockReason: null,
  members: [
    { stopNo: 1, doNumber: "HC-DO-2608-101", status: "LOADED", step: { status: "DISPATCHED", label: "Confirm Loaded", note: "n" }, blockReason: null },
    { stopNo: 2, doNumber: null, status: null, step: null, blockReason: "This drop is on another company's books, so this sheet cannot move it. Call the office." },
  ],
};

describe("the packing-list sheet", () => {
  it("reads as a run: trip number, drop count, and one button for all of it", async () => {
    serve(RUN);
    await mount();
    expect(screen.getByText("TRIP-2608-001")).toBeTruthy();
    expect(screen.getByText(/2 drops on this run/)).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toContain("Confirm Loaded");
  });

  it("shows the foreign drop BEFORE the press, by stop number and with no document number", async () => {
    serve(RUN);
    await mount();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("Not on this run's account")).toBeTruthy();
    /* getAllBy, not getBy: the sentence under the button also names the
       other-company case, and that is deliberate — the driver is told both
       before he presses and beside the drop itself. */
    expect(screen.getAllByText(/another company's books/).length).toBeGreaterThan(0);
    /* The other company's document number must not be anywhere on the page. */
    expect(document.body.textContent).not.toContain("HC-DO-2608-102");
  });

  it("lists what happened to EVERY drop after the press", async () => {
    serve(RUN, {
      kind: "trip", tripNo: "TRIP-2608-001", outcome: "PARTIAL", to: "DISPATCHED",
      message: "1 recorded, 1 not moved — check the list below and call the office about those.",
      members: [
        { stopNo: 1, doNumber: "HC-DO-2608-101", outcome: "DONE", from: "LOADED", to: "DISPATCHED", message: "Recorded as loaded onto the lorry." },
        { stopNo: 2, doNumber: null, outcome: "BLOCKED", from: null, message: "This drop is on another company's books, so this sheet cannot move it. Call the office." },
      ],
    });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText(/1 recorded, 1 not moved/)).toBeTruthy();
    expect(screen.getByText(/Recorded as loaded onto the lorry/)).toBeTruthy();
    expect(screen.getAllByText(/another company's books/).length).toBeGreaterThan(0);
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
  });

  it("says the button moves the whole run, and what it will leave alone", async () => {
    serve(RUN);
    await mount();
    expect(screen.getByText(/every drop on this run that is ready for it/)).toBeTruthy();
    expect(screen.getByText(/already done, on hold, or on another company/)).toBeTruthy();
  });

  it("an empty run says so instead of offering a button", async () => {
    serve({ ...RUN, step: null, members: [], blockReason: "There is nothing on this packing list yet. Call the office." });
    await mount();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByText(/nothing on this packing list yet/).length).toBeGreaterThan(0);
  });
});
