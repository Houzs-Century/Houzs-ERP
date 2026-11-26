import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch, listFieldPhotos } = vi.hoisted(() => ({ authedFetch: vi.fn(), listFieldPhotos: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/lib/dialog-service", () => ({ serviceNotify: vi.fn() }));
vi.mock("../vendor/scm/lib/slip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/slip")>()),
  uploadFieldPhoto: vi.fn(async () => ({ r2Key: "slips/2026/10/pod-test.jpg" })),
}));
vi.mock("../vendor/scm/lib/crew-stop-photos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/crew-stop-photos")>()),
  listCrewStopPhotos: (context: string) => listFieldPhotos(context),
}));
vi.mock("../lib/photoStamp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/photoStamp")>()),
  stampNow: vi.fn(async () => ({ at: new Date("2026-11-08T06:00:00Z"), source: "server" as const })),
}));

vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("../auth/salesAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/salesAccess")>()),
  canOperateDeliveryOrders: () => true,
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-1" }, can: () => true, pageAccess: () => "write" }),
}));

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
  listFieldPhotos.mockReset();
  listFieldPhotos.mockResolvedValue([]);
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

function sentBody(): Record<string, unknown> {
  const [, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body));
}

const attachPhoto = async (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("the photo input did not render");
  fireEvent.change(input, { target: { files: [new File(["jpeg"], "pod.jpg", { type: "image/jpeg" })] } });
  await screen.findByText("Uploaded");
};

const pad = (container: HTMLElement): HTMLCanvasElement => {
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("the signature pad did not render");
  return canvas as HTMLCanvasElement;
};

describe("MobilePOD — the customer's signature reaches the payload", () => {
  it("a stroke on the pad sends signatureData with the delivery", async () => {
    const { container } = wrap();

    fireEvent.pointerDown(pad(container), { clientX: 12, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(pad(container), { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(pad(container), { pointerId: 1 });

    expect(screen.getByText("Signed")).toBeTruthy();

    await attachPhoto(container);
    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/delivery-orders-mfg/do-uuid-1/status");
    expect(init.method).toBe("PATCH");

    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body.podKey).toBe("slips/2026/10/pod-test.jpg");
    expect(body.signatureData).toBe(DRAWN_PNG);
    expect(String(body.signatureData).length).toBeGreaterThan(2000);
  });

  it("an untouched pad sends NO signature key at all", async () => {
    const { container } = wrap();
    expect(pad(container)).toBeTruthy();
    expect(screen.getByText("Ask the customer to sign above")).toBeTruthy();

    await attachPhoto(container);
    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    const body = sentBody();
    expect(body.status).toBe("DELIVERED");
    expect(body).not.toHaveProperty("signatureData");
  });

  it("Clear and re-sign takes the signature back off the payload", async () => {
    const { container } = wrap();

    fireEvent.pointerDown(pad(container), { clientX: 12, clientY: 20, pointerId: 1 });
    expect(screen.getByText("Signed")).toBeTruthy();

    fireEvent.click(screen.getByText("Clear & re-sign"));
    expect(screen.getByText("Ask the customer to sign above")).toBeTruthy();

    await attachPhoto(container);
    fireEvent.click(screen.getByText("Confirm delivered →"));

    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty("signatureData");
  });

  it("refuses to close a delivery without a photo, and sends nothing", async () => {
    wrap();
    await waitFor(() => expect(screen.queryByText(/Checking for photos you already uploaded/)).toBeNull());
    fireEvent.click(screen.getByText("Confirm delivered →"));
    expect(await screen.findByText(/Take a POD photo first/)).toBeTruthy();
    const writes = (authedFetch.mock.calls as Array<[string, RequestInit | undefined]>).filter(([, init]) => init?.method && init.method !== "GET");
    expect(writes).toEqual([]);
  });

  it("after a page reload, the photo uploaded before it comes back and goes with the delivery", async () => {
    listFieldPhotos.mockResolvedValue([{ uploadSessionId: "s-old", r2Key: "slips/2026/11/before-reload.jpg", contentType: "image/jpeg", createdAt: "2026-11-10T01:00:00Z", uploadedBy: { id: 7, name: "Faslie" }, mine: true, canRemove: true }]);
    wrap();
    expect(await screen.findByText("Uploaded")).toBeTruthy();
    expect(listFieldPhotos).toHaveBeenCalledWith("do:do-uuid-1");
    fireEvent.click(screen.getByText("Confirm delivered →"));
    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(sentBody().podKey).toBe("slips/2026/11/before-reload.jpg");
  });
});
