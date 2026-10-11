/* THE POD SCREEN AFTER THE SIGNATURE WAS RETIRED.
 *
 * WHAT THIS FILE WAS. `MobilePodSignatureCapture.test.tsx`, which pinned the
 * pad → latch → payload chain in both directions: drawing sent `signatureData`,
 * an untouched pad sent none, and Clear took it back off. That chain no longer
 * exists, so those three assertions were not weakened — their SUBJECT was
 * removed by an owner ruling, and an assertion about a deleted feature is not a
 * guard, it is a fossil.
 *
 * Owner, 2026-08-21: 「签收签名不需要 先 delete掉」.
 *
 * WHY IT WAS REPURPOSED RATHER THAN DELETED. Two of the three things this file
 * covered are still real and still fragile:
 *
 *   1. The OTHER evidence — the delivery photo and the GPS fix — travels
 *      through exactly the same payload the signature used to ride in. Deleting
 *      this file would have taken the only end-to-end coverage of that path with
 *      it, on the same day that path was edited. It is asserted below.
 *   2. The removal itself needs a guard. The pad was re-added once already in
 *      spirit — this screen has twice shipped a signature bug in opposite
 *      directions (a blank PNG on every confirm before 2026-08-14, then a latch
 *      that was the only thing letting one through). "No pad, no `signatureData`,
 *      ever" is now the property, and nothing else would notice it breaking.
 *
 * WHAT IS DELIBERATELY NOT HERE. The database column `delivery_orders.signature_data`
 * still exists and is NOT dropped by this change — it holds 0 rows, and a column
 * drop is irreversible and a separate decision. Nothing writes it any more, which
 * is what these tests pin.
 *
 * WHAT THIS TEST DOES NOT PROVE, said plainly. jsdom has no canvas and no
 * geolocation; both are stubbed. This pins the WIRING — capture → payload — and
 * says nothing about the bytes a real handset encodes or the fix it reports.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/lib/dialog-service", () => ({ serviceNotify: vi.fn() }));

/* The photo rides to R2 before the PATCH. Stubbed so the payload is measurable
   without a bucket; the REAL upload path is not under test here. */
const { uploadSlipFull } = vi.hoisted(() => ({ uploadSlipFull: vi.fn() }));
vi.mock("../vendor/scm/lib/slip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/slip")>()),
  uploadSlipFull,
}));

/* The confirm dialog names what is being lost and then lets the delivery close
   either way (owner's loosen-not-restrict rule). Always answering yes is the
   path under test — a driver who cancels never reaches the payload. The ARGUMENT
   is captured because "names what it is losing" is itself an assertion below. */
const confirmCalls: Array<{ title?: string; body?: string }> = [];
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async (opts: { title?: string; body?: string }) => {
    confirmCalls.push(opts);
    return true;
  },
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
  confirmCalls.length = 0;
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ deliveryOrder: { id: "do-uuid-1", status: "DELIVERED" } });
  uploadSlipFull.mockReset();
  uploadSlipFull.mockResolvedValue({ r2Key: "pod/2026/do-uuid-1.jpg" });
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

const confirmDelivered = () => fireEvent.click(screen.getByText("Confirm delivered →"));

describe("MobilePOD no longer asks anybody to sign", () => {
  it("renders no signature pad", () => {
    /* The pad was the only <canvas> on this screen. */
    const { container } = wrap();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("shows no signature wording anywhere on the screen", () => {
    const { container } = wrap();
    expect(container.textContent).not.toMatch(/sign/i);
  });

  it("never sends signatureData, even though the payload still carries evidence", async () => {
    const { container } = wrap();
    const file = new File(["x"], "pod.jpg", { type: "image/jpeg" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    confirmDelivered();

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body).not.toHaveProperty("signatureData");
  });
});

describe("MobilePOD still carries the evidence that was KEPT", () => {
  it("a delivery photo reaches the payload as podKey", async () => {
    /* The owner named the signature only. The photo and the GPS stay, so the
       path that carries them is still under test on the day it was edited. */
    const { container } = wrap();
    const file = new File(["x"], "pod.jpg", { type: "image/jpeg" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    confirmDelivered();

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/do-uuid-1/status");
    expect(init.method).toBe("PATCH");
    expect(sentBody().podKey).toBe("pod/2026/do-uuid-1.jpg");
  });

  it("a GPS fix reaches the payload as the pod_* quartet", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) =>
          ok({
            coords: { latitude: 3.139, longitude: 101.6869, accuracy: 12 },
            timestamp: Date.parse("2026-08-21T02:00:00.000Z"),
          }),
      },
    });
    wrap();

    fireEvent.click(screen.getByText("Capture GPS"));
    await waitFor(() => expect(screen.getByText("3.13900, 101.68690")).toBeTruthy());

    confirmDelivered();

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const body = sentBody();
    expect(body.podLat).toBe(3.139);
    expect(body.podLng).toBe(101.6869);
    expect(body.podAccuracyM).toBe(12);
    expect(body.podLocatedAt).toBe("2026-08-21T02:00:00.000Z");
  });

  it("closing with nothing attached is ALLOWED, and says what is being lost", async () => {
    /* The property the merged evidence work established, which this change must
       not undo: evidence is allowed on every closing path and required on none,
       and each path names what it is losing. It just stops naming a signature. */
    wrap();
    confirmDelivered();

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body).not.toHaveProperty("podKey");

    const said = confirmCalls.at(-1)?.body ?? "";
    expect(said).toMatch(/photo/i);
    expect(said).not.toMatch(/sign/i);
  });
});
