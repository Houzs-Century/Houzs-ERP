/* "Delivered with issue" on the POD screen (sister review A2): the crew ticks
 * the problem, adds photos, and confirms. The delivery is saved FIRST, exactly
 * as a plain delivery, and the problem report follows — so a problem never
 * blocks the delivery, and a failed report says so instead of closing. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/lib/dialog-service", () => ({ serviceNotify: vi.fn() }));
vi.mock("../vendor/scm/lib/slip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/slip")>()),
  uploadSlipFull: vi.fn(async ({ file }: { file: File }) => ({ r2Key: `slips/2026/11/${file.name}` })),
  uploadFieldPhoto: vi.fn(async ({ file }: { file: File }) => ({ r2Key: `slips/2026/11/${file.name}` })),

  // No photos uploaded earlier for this stop (the re-list after a reload).
  listFieldPhotos: vi.fn(async () => []),
}));
vi.mock("../lib/photoStamp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/photoStamp")>()),
  stampNow: vi.fn(async () => ({ at: new Date("2026-11-09T06:00:00Z"), source: "server" as const })),
}));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
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
      data: { deliveryOrders: [{ id: "do-uuid-1", do_number: "DO-2611-001", status: "DISPATCHED" }] },
      isPending: false, error: null,
    }),
    useMfgDeliveryOrderDetail: () => ({
      data: {
        deliveryOrder: { id: "do-uuid-1", do_number: "DO-2611-001", debtor_name: "A Customer", status: "DISPATCHED", phone: null, city: null, state: null, customer_state: null },
        items: [{ id: "li-1", description: "Sofa", description2: null, item_code: "SOFA-3", qty: 1 }],
      },
      isPending: false, error: null,
    }),
  };
});

import { MobilePOD } from "./MobilePOD";

type Init = { method?: string; body?: string };
const calls = () => authedFetch.mock.calls as Array<[string, Init | undefined]>;
const posted = (suffix: string) => calls().find(([u, i]) => u.endsWith(suffix) && (i?.method === "POST" || i?.method === "PATCH"));

let reportFails = false;
beforeEach(() => {
  reportFails = false;
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string, init?: Init) => {
    if (url.endsWith("/delivery-issue")) {
      if (reportFails) throw new Error("Network down");
      return { issue: { id: "iss-1", assr_no: "ASSR/2611-001" } };
    }
    if (url.endsWith("/delivery-issues")) return { issues: [] };
    if (init?.method === "PATCH") return { deliveryOrder: { id: "do-uuid-1", status: "DELIVERED" } };
    return {};
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const wrap = () => {
  const onDone = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const r = render(<QueryClientProvider client={qc}><MobilePOD docNo="DO-2611-001" onBack={vi.fn()} onDone={onDone} /></QueryClientProvider>);
  return { ...r, onDone };
};
const jpeg = (name: string) => new File(["jpeg"], name, { type: "image/jpeg" });
/* POD photos upload on pick, so wait until the photo shows as uploaded. */
const attachPodPhoto = async (c: HTMLElement) => {
  fireEvent.change(c.querySelector('input[type="file"]')!, { target: { files: [jpeg("pod.jpg")] } });
  await screen.findByText("Uploaded");
};

describe("MobilePOD — delivered with issue", () => {
  it("refuses to confirm with the issue form open and nothing ticked, before saving anything", async () => {
    const { container } = wrap();
    await attachPodPhoto(container);
    fireEvent.click(screen.getByText("Delivered with issue"));
    fireEvent.click(screen.getByText("Confirm delivered with issue →"));
    expect(await screen.findByText("Tick at least one problem.")).toBeTruthy();
    expect(posted("/status")).toBeUndefined();
  });

  it("saves the delivery first, then reports the ticked problems with their photos", async () => {
    const { container, onDone } = wrap();
    await attachPodPhoto(container);
    fireEvent.click(screen.getByText("Delivered with issue"));
    const form = screen.getByTestId("delivery-issue-form");
    fireEvent.click(within(form).getByLabelText("Damaged"));
    fireEvent.click(within(form).getByLabelText("Missing part"));
    fireEvent.change(within(form).getByPlaceholderText("Note for the office (optional)"), { target: { value: "Armrest torn" } });
    fireEvent.change(form.querySelector('input[type="file"]')!, { target: { files: [jpeg("torn.jpg")] } });
    fireEvent.click(screen.getByText("Confirm delivered with issue →"));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const statusIdx = calls().findIndex(([u, i]) => u.endsWith("/status") && i?.method === "PATCH");
    const issueIdx = calls().findIndex(([u]) => u.endsWith("/delivery-issue"));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(issueIdx).toBeGreaterThan(statusIdx);
    expect(JSON.parse(calls()[statusIdx]![1]!.body!).status).toBe("DELIVERED");
    const [url, init] = calls()[issueIdx]!;
    expect(url).toBe("/delivery-orders-mfg/DO-2611-001/delivery-issue");
    expect(JSON.parse(init!.body!)).toEqual({ kinds: ["damaged", "missing_part"], note: "Armrest torn", photoKeys: ["slips/2026/11/torn.jpg"] });
  });

  it("a failed report keeps the screen open and says the delivery is saved", async () => {
    reportFails = true;
    const { container, onDone } = wrap();
    await attachPodPhoto(container);
    fireEvent.click(screen.getByText("Delivered with issue"));
    fireEvent.click(within(screen.getByTestId("delivery-issue-form")).getByLabelText("Wrong item or colour"));
    fireEvent.click(screen.getByText("Confirm delivered with issue →"));
    expect(await screen.findByText(/The delivery is saved, but the problem report did not send: Network down/)).toBeTruthy();
    expect(posted("/status")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Other needs a note", async () => {
    const { container } = wrap();
    await attachPodPhoto(container);
    fireEvent.click(screen.getByText("Delivered with issue"));
    fireEvent.click(within(screen.getByTestId("delivery-issue-form")).getByLabelText("Other"));
    fireEvent.click(screen.getByText("Confirm delivered with issue →"));
    expect(await screen.findByText('Describe the problem when you tick "Other".')).toBeTruthy();
    expect(posted("/status")).toBeUndefined();
  });

  it("a plain delivery sends no problem report", async () => {
    const { container, onDone } = wrap();
    await attachPodPhoto(container);
    fireEvent.click(screen.getByText("Confirm delivered →"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(posted("/delivery-issue")).toBeUndefined();
  });
});
