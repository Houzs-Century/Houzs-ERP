/* THE SIGNATURE IS GONE, AND THE PHOTO AND GPS ARE NOT.
 *
 * Owner ruling, 2026-08-21: 「签收签名不需要 先delete掉」 — the delivery signature
 * is not needed, take it off. He named the signature and only the signature, so
 * this file pins BOTH halves of that: the pad and its payload key are gone, and
 * the two evidence fields standing beside them on the same screen still work.
 *
 * WHY HE IS RIGHT, and it is a measurement rather than an opinion. Census run
 * 32462178224 read every delivery order in the database — every status, all
 * time, all three tables that carry proof-of-delivery columns — and reported
 * `signature 0, photo 0, gps 0` across 39 rows. The twelve rows that are
 * "closed" were all flipped in a single minute on 2026-07-24 by
 * backfill-2990-delivered-dos.mjs, not by a person. The path was never broken.
 * Nothing has ever gone through it.
 *
 * THIS FILE REPLACES MobilePodSignatureCapture.test.tsx, which pinned the
 * opposite — that a stroke on the pad reached `signatureData`. That test was
 * right for the code it guarded and is not deleted quietly: it is renamed in
 * place so the history of this screen stays in one file, and the assertions are
 * inverted to guard the removal instead. Without an inverted guard the pad can
 * come back the way it arrived, silently.
 *
 * WHAT THIS DOES NOT PROVE. jsdom does not run a real camera, a real R2 upload
 * or a real geolocation provider; those are stubbed. This pins the WIRING —
 * what the screen renders and what it puts in the payload — not what a handset
 * encodes.
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
   or the Confirm button is not rendered and there is nothing to measure. */
vi.mock("../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/salesAccess")>()),
  canOperateDeliveryOrders: () => true,
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-1" }, can: () => true, pageAccess: () => "write" }),
}));

/* The R2 upload is the one part of the photo path that talks to a network. */
vi.mock("../vendor/scm/lib/slip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/slip")>()),
  uploadSlipFull: vi.fn(async () => ({ r2Key: "pod/2026/do-uuid-1.jpg" })),
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

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-uuid-1", status: "DELIVERED" } });
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

describe("MobilePOD — the signature capture is retired", () => {
  it("renders no signature pad and asks nobody to sign", () => {
    const { container } = wrap();
    /* The canvas IS the pad — there is no other canvas on this screen, which is
       why its absence is the assertion rather than a label lookup. */
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByText("Customer signature")).toBeNull();
    expect(screen.queryByText("Ask the customer to sign above")).toBeNull();
    expect(screen.queryByText("Clear & re-sign")).toBeNull();
  });

  it("sends NO signatureData key when the delivery is confirmed", async () => {
    wrap();
    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/do-uuid-1/status");
    expect(init.method).toBe("PATCH");

    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body).not.toHaveProperty("signatureData");
  });
});

describe("MobilePOD — the evidence he did NOT name still works", () => {
  it("a delivery photo still reaches the payload as podKey", async () => {
    const { container } = wrap();
    const file = new File([new Uint8Array([1, 2, 3])], "door.jpg", { type: "image/jpeg" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.click(screen.getByText("Confirm delivered →"));
    await waitFor(() => expect(authedFetch).toHaveBeenCalled());

    const body = sentBody();
    expect(body.podKey).toBe("pod/2026/do-uuid-1.jpg");
    expect(body).not.toHaveProperty("signatureData");
  });

  it("a GPS fix still reaches the payload as podLat / podLng", async () => {
    Object.defineProperty(globalThis.navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({
            coords: { latitude: 3.139, longitude: 101.6869, accuracy: 12 },
            timestamp: Date.parse("2026-08-21T02:00:00.000Z"),
          } as GeolocationPosition),
      },
    });

    wrap();
    fireEvent.click(screen.getByText("Capture GPS"));
    await waitFor(() => expect(screen.getByText("3.13900, 101.68690")).toBeTruthy());

    fireEvent.click(screen.getByText("Confirm delivered →"));
    await waitFor(() => expect(authedFetch).toHaveBeenCalled());

    const body = sentBody();
    expect(body.podLat).toBe(3.139);
    expect(body.podLng).toBe(101.6869);
    expect(body.podAccuracyM).toBe(12);
    expect(body).not.toHaveProperty("signatureData");
  });
});
