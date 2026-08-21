/* A DRAWN SIGNATURE MUST REACH THE PAYLOAD — the half of the POD chain that
 * nothing was testing.
 *
 * WHY THIS FILE EXISTS. On 2026-08-21 a production census
 * (backend/scripts/check-pod-evidence.mjs, run 32457160124) reported that
 * `signature_data` is non-null on ZERO of the 39 delivery orders that exist,
 * in every status, for all time. Two explanations fit that number and they
 * need opposite responses: nobody has opened the POD screen, or the screen
 * captures a signature and drops it on the floor. The census cannot tell them
 * apart and neither can reading the source.
 *
 * `do-status-evidence.test.tsx` already pins the half AFTER the payload —
 * evidence handed to `useUpdateMfgDeliveryOrderStatus` reaches the endpoint.
 * Nothing pinned the half BEFORE it: that drawing on the pad is what puts the
 * signature into that object at all.
 *
 * That half is the fragile one, and it has already been wrong twice in
 * opposite directions:
 *
 *   before 2026-08-14  `sig ? …` — an untouched, fully transparent pad still
 *     returns a valid non-empty PNG from toDataURL, so EVERY confirm stored a
 *     blank image that is indistinguishable from a real POD that failed to
 *     render.
 *   after  2026-08-14  `hasSignature ? …` — correct, and now the ONLY thing
 *     that lets a signature through is a boolean latch set by one pointerdown
 *     handler on a canvas. If that latch ever stops arming, the driver draws,
 *     sees the ink, taps Confirm, and nothing is stored — silently, with the
 *     column reading exactly as it does today.
 *
 * So both directions are asserted here: drawing sends it, not drawing does not.
 *
 * WHAT THIS TEST DOES NOT PROVE, said plainly. jsdom has no canvas
 * implementation (`canvas` is not a dependency of this app), so
 * `getContext`/`toDataURL` are stubbed below. This pins the WIRING — pad →
 * latch → payload — and says nothing about the bytes a real phone's browser
 * encodes. The only thing that settles that is one delivery closed through the
 * POD screen on a real handset, after which the census above reports it.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/lib/dialog-service", () => ({ serviceNotify: vi.fn() }));

/* The confirm dialog names what is being lost and then lets the delivery close
   either way (owner's loosen-not-restrict rule). Always answering yes is the
   path under test — a driver who cancels never reaches the payload. */
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

/* The operate gate is asserted by its own tests; here it must simply be OPEN,
   or the Confirm button is not rendered and there is nothing to measure.
   `importOriginal` keeps every other export real so an unrelated import out of
   this module does not silently become undefined. */
vi.mock("../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/salesAccess")>()),
  canOperateDeliveryOrders: () => true,
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-1" }, can: () => true, pageAccess: () => "write" }),
}));

/* The two READ hooks are stubbed so the screen renders a delivery without a
   server; the WRITE hook is deliberately the REAL one, because the payload it
   builds is the thing under test. */
vi.mock("../vendor/scm/lib/delivery-order-queries", async (importOriginal) => {
  const real = await importOriginal<typeof import("../vendor/scm/lib/delivery-order-queries")>();
  return {
    ...real,
    useMfgDeliveryOrdersPaged: () => ({
      data: { deliveryOrders: [{ id: "do-uuid-1", do_number: "DO-2608-001", status: "DISPATCHED" }] },
      isPending: false,
      error: null,
    }),
    useMfgDeliveryOrderDetail: () => ({
      data: {
        deliveryOrder: {
          id: "do-uuid-1",
          do_number: "DO-2608-001",
          debtor_name: "A Customer",
          status: "DISPATCHED",
          phone: null,
          city: "Kuala Lumpur",
          state: null,
          customer_state: null,
        },
        items: [{ id: "li-1", description: "Mattress", description2: "Queen", item_code: "AKEMI-QD", qty: 1 }],
      },
      isPending: false,
      error: null,
    }),
  };
});

import { MobilePOD } from "./MobilePOD";

/* A stand-in for what a real browser returns for a canvas carrying strokes.
   Deliberately longer than the 2,000-byte reporting boundary the production
   census uses to tell a drawn signature from a blank pad, so the assertion
   below measures the same thing the census does. */
const DRAWN_PNG = `data:image/png;base64,${"QUJDRA".repeat(700)}`;

const ctx2d = {
  scale: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  lineWidth: 0,
  lineCap: "",
  lineJoin: "",
  strokeStyle: "",
};

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-uuid-1", status: "DELIVERED" } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx2d as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(DRAWN_PNG);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MobilePOD docNo="DO-2608-001" onBack={vi.fn()} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
};

/** The body the screen actually PATCHed, parsed. */
function sentBody(): Record<string, unknown> {
  const [, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body));
}

const pad = (container: HTMLElement): HTMLCanvasElement => {
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("the signature pad did not render");
  return canvas as HTMLCanvasElement;
};

describe("MobilePOD — the customer's signature reaches the payload", () => {
  it("a stroke on the pad sends signatureData with the delivery", async () => {
    const { container } = wrap();

    /* One pointerdown is the whole latch: SignaturePad's `start()` flags the
       first mark of a fresh pad. A driver who touches the pad has signed. */
    fireEvent.pointerDown(pad(container), { clientX: 12, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(pad(container), { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(pad(container), { pointerId: 1 });

    /* The screen must SAY it has one before it claims to send one — this label
       and the payload are driven by the same flag, and a driver reads it. */
    expect(screen.getByText("Signed")).toBeTruthy();

    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/do-uuid-1/status");
    expect(init.method).toBe("PATCH");

    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body.signatureData).toBe(DRAWN_PNG);
    /* The census counts a signature as REAL at 2,000 bytes. A payload the
       screen calls a signature must clear the same bar, or the row it writes
       will be reported as the blank-pad bug it is not. */
    expect(String(body.signatureData).length).toBeGreaterThan(2000);
  });

  it("an untouched pad sends NO signature key at all", async () => {
    /* The pre-2026-08-14 bug, pinned so it cannot return: `toDataURL` on an
       untouched transparent pad is a valid non-empty PNG, so anything that
       reads the canvas instead of the latch stores a blank image on every
       single delivery. The stub above returns a long data URL precisely so
       that a regression here FAILS rather than accidentally passing. */
    const { container } = wrap();
    expect(pad(container)).toBeTruthy();
    expect(screen.getByText("Ask the customer to sign above")).toBeTruthy();

    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body).not.toHaveProperty("signatureData");
  });

  it("Clear and re-sign takes the signature back off the payload", async () => {
    /* A customer who starts to sign and stops, or a mis-tap, must not leave a
       scribble filed as their proof of delivery. Clear re-arms the latch, and
       the payload has to follow the latch rather than the canvas. */
    const { container } = wrap();

    fireEvent.pointerDown(pad(container), { clientX: 12, clientY: 20, pointerId: 1 });
    expect(screen.getByText("Signed")).toBeTruthy();

    fireEvent.click(screen.getByText("Clear & re-sign"));
    expect(screen.getByText("Ask the customer to sign above")).toBeTruthy();

    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty("signatureData");
  });
});
