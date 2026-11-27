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
    expect(body).not.toMatch(/\b\d{5}\b/);
  });
});

const RUN = {
  kind: "trip",
  mode: "load_all",
  tripNo: "TRIP-2608-001",
  tripDate: "2026-08-26",
  lorryPlate: "VJK 8821",
  status: "PLANNED",
  step: { status: "DISPATCHED", label: "Mark whole lorry loaded", note: "Press this once everything on this packing list is on the lorry." },
  blockReason: null,
  members: [
    { stopNo: 1, doNumber: "HC-DO-2608-101", customerName: "Customer One", status: "LOADED", willLoad: true, note: "Will be marked Loaded." },
    { stopNo: 2, doNumber: null, customerName: null, status: null, willLoad: false, note: "This drop is on another company's books, so this sheet cannot move it. Call the office." },
    { stopNo: 3, doNumber: "HC-DO-2608-103", customerName: "Customer Three", status: "DRAFT", willLoad: false, note: "Not confirmed yet (Draft), so it was not loaded. The office must confirm it first." },
  ],
};

describe("the packing-list sheet: SCAN WHEN FULLY LOADED", () => {
  it("reads as one lorry, with one button that loads all of it", async () => {
    serve(RUN);
    await mount();
    expect(screen.getByText("Scan packing list")).toBeTruthy();
    expect(screen.getByText("Lorry VJK 8821")).toBeTruthy();
    expect(screen.getByText(/3 delivery orders/)).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toContain("Mark whole lorry loaded");
  });

  it("shows every drop BEFORE the press: number, customer, status and what will happen", async () => {
    serve(RUN);
    await mount();
    expect(screen.getByText("Customer One")).toBeTruthy();
    expect(screen.getByText("Will be marked Loaded.")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.getByText(/Not confirmed yet \(Draft\)/)).toBeTruthy();
    expect(screen.getByText("Not on this run's account")).toBeTruthy();
    expect(document.body.textContent).not.toContain("HC-DO-2608-102");
  });

  it("POSTs the Loaded step only", async () => {
    serve(RUN);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ to: "DISPATCHED" });
  });

  it("after the press: the headline, and what happened to EVERY drop", async () => {
    serve(RUN, {
      kind: "trip", mode: "load_all", tripNo: "TRIP-2608-001", lorryPlate: "VJK 8821", outcome: "PARTIAL",
      to: "DISPATCHED", headline: "Lorry VJK 8821: 1 of 3 delivery orders loaded",
      message: "2 not loaded: see the list below and call the office about them.",
      total: 3, loaded: 1, moved: 1,
      members: [
        { stopNo: 1, doNumber: "HC-DO-2608-101", customerName: "Customer One", outcome: "DONE", from: "LOADED", to: "DISPATCHED", status: "DISPATCHED", message: "Marked as loaded." },
        { stopNo: 2, doNumber: null, customerName: null, outcome: "BLOCKED", from: null, status: null, message: "This drop is on another company's books, so this sheet cannot move it. Call the office." },
        { stopNo: 3, doNumber: "HC-DO-2608-103", customerName: "Customer Three", outcome: "BLOCKED", from: "DRAFT", status: "DRAFT", message: "Not confirmed yet (Draft), so it was not loaded. The office must confirm it first." },
      ],
    });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText("Lorry VJK 8821: 1 of 3 delivery orders loaded")).toBeTruthy();
    expect(screen.getByText(/2 not loaded/)).toBeTruthy();
    expect(screen.getByText("Marked as loaded.")).toBeTruthy();
    expect(screen.getByText("Loaded")).toBeTruthy();
    expect(screen.getAllByText(/another company's books/).length).toBeGreaterThan(0);
    for (const n of ["#1", "#2", "#3"]) expect(screen.getByText(n)).toBeTruthy();
  });

  it("says what the button leaves alone", async () => {
    serve(RUN);
    await mount();
    expect(screen.getByText(/Only confirmed delivery orders are marked Loaded/)).toBeTruthy();
  });

  it("a lorry whose delivery orders are all already loaded offers no button", async () => {
    serve({ ...RUN, step: null, blockReason: "Everything on this lorry is already loaded. Nothing to do." });
    await mount();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/already loaded/)).toBeTruthy();
  });

  it("an empty run says so instead of offering a button", async () => {
    serve({ ...RUN, step: null, members: [], blockReason: "There is nothing on this packing list yet. Call the office." });
    await mount();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByText(/nothing on this packing list yet/).length).toBeGreaterThan(0);
  });
});

describe("the lorry-day packing list (no trip behind it)", () => {
  const SHEET = {
    ...RUN, kind: "lorry_day", tripNo: null, tripDate: "2026-11-28",
    members: [
      { stopNo: 1, doNumber: "HC-DO-2611-201", customerName: "Customer One", status: "LOADED", willLoad: true, note: "Will be marked Loaded." },
      { stopNo: 2, doNumber: "HC-DO-2611-202", customerName: "Customer Two", status: "LOADED", willLoad: false, note: "Moved to another lorry since this sheet was printed, so it was not touched. Check with the office." },
    ],
  };

  it("reads as the lorry and its day, with the moved DO named before the press", async () => {
    serve(SHEET);
    await mount();
    expect(screen.getByText("Lorry VJK 8821")).toBeTruthy();
    expect(screen.getByText(/2026-11-28 · 2 delivery orders/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("null");
    expect(screen.getByText(/Moved to another lorry/)).toBeTruthy();
    expect(screen.getByRole("button").textContent).toContain("Mark whole lorry loaded");
  });

  it("after the press shows the headline and the moved DO as not loaded", async () => {
    serve(SHEET, {
      kind: "lorry_day", mode: "load_all", tripNo: null, lorryPlate: "VJK 8821", outcome: "PARTIAL", to: "DISPATCHED",
      headline: "Lorry VJK 8821: 1 of 2 delivery orders loaded", message: "1 not loaded: see the list below and call the office about it.",
      total: 2, loaded: 1, moved: 1,
      members: [
        { stopNo: 1, doNumber: "HC-DO-2611-201", customerName: "Customer One", outcome: "DONE", from: "LOADED", to: "DISPATCHED", status: "DISPATCHED", message: "Marked as loaded." },
        { stopNo: 2, doNumber: "HC-DO-2611-202", customerName: "Customer Two", outcome: "MOVED", from: "LOADED", status: "LOADED", message: "Moved to another lorry since this sheet was printed, so it was not touched. Check with the office." },
      ],
    });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button")); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(screen.getByText("Lorry VJK 8821: 1 of 2 delivery orders loaded")).toBeTruthy();
    expect(screen.getByText(/Moved to another lorry/)).toBeTruthy();
  });
});
