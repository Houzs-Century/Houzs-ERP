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
