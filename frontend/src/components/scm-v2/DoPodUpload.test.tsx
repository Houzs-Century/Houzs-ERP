/* An SO row's drawer takes the POD upload too (owner, 2026-11-17: every job can
 * take a POD upload): on the road it is the DO's own POD flip, delivered it
 * appends to the DO's POD, a draft or cancelled DO takes none. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authedFetch, mutateAsync, clear } = vi.hoisted(() => ({
  authedFetch: vi.fn(async () => ({})),
  mutateAsync: vi.fn(async () => ({})),
  clear: vi.fn(),
}));
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../../vendor/scm/lib/delivery-order-queries", () => ({ useUpdateMfgDeliveryOrderStatus: () => ({ mutateAsync }) }));
vi.mock("../../vendor/scm/lib/slip", () => ({
  fieldPhotoContext: (s: { doId: string }) => `do:${s.doId}`,
  uploadFieldPhoto: vi.fn(),
}));
vi.mock("../../lib/fieldPhotos", () => ({
  serverFieldPhotoRestore: () => null,
  useFieldPhotos: () => ({
    photos: [{ id: "1" }, { id: "2" }],
    gate: () => ({ ok: true, keys: ["slips/a.jpg", "slips/b.jpg"] }),
    clear,
  }),
}));
vi.mock("../FieldPhotos", () => ({ FieldPhotos: () => null }));

import { DoPodUpload } from "./DoPodUpload";

const renderIt = (status: string, extra: Record<string, unknown> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DoPodUpload h={{ id: "do-1", status, pod_photo_keys: [], ...extra }} />
    </QueryClientProvider>,
  );

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("DoPodUpload", () => {
  it("a DO on the road is marked delivered through its own POD flip, with every photo", async () => {
    renderIt("DISPATCHED");
    fireEvent.click(screen.getByRole("button", { name: "Mark delivered with these photos" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      id: "do-1", status: "DELIVERED", evidence: { podKey: "slips/a.jpg", podKeys: ["slips/a.jpg", "slips/b.jpg"] },
    }));
    expect(authedFetch).not.toHaveBeenCalled();
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });

  it("a delivered DO appends the photos to its POD and moves nothing", async () => {
    renderIt("DELIVERED", { pod_photo_keys: ["slips/crew.jpg"] });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 photos" }));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith("/delivery-orders-mfg/do-1/pod-photos", {
      method: "POST", body: JSON.stringify({ photoKeys: ["slips/a.jpg", "slips/b.jpg"] }),
    }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    authedFetch.mockRejectedValueOnce(new Error("At most 40 photos."));
    renderIt("DELIVERED");
    fireEvent.click(screen.getByRole("button", { name: "Add 2 photos" }));
    expect(await screen.findByText("At most 40 photos.")).toBeTruthy();
  });

  it("a draft is confirmed first, and a cancelled DO takes no POD", () => {
    renderIt("DRAFT");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Confirm the delivery order first/)).toBeTruthy();
    cleanup();
    renderIt("CANCELLED");
    expect(screen.getByText(/cancelled; it takes no POD/)).toBeTruthy();
  });
});
