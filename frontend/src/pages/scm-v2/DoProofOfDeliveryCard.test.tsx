/* The DO page must show what the crew recorded on the phone (owner,
 * 2026-10-08). Before this card a delivered DO read "Delivered: Pending" and
 * carried its POD photo, signature and times invisibly. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchBlobUrl } = vi.hoisted(() => ({ fetchBlobUrl: vi.fn(async () => "blob:pod-photo") }));
vi.mock("../../api/client", () => ({ api: { fetchBlobUrl } }));

import { DoProofOfDeliveryCard, doIsDelivered } from "./DoProofOfDeliveryCard";

const wrap = (h: Parameters<typeof DoProofOfDeliveryCard>[0]["h"]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DoProofOfDeliveryCard h={h} />
    </QueryClientProvider>,
  );

afterEach(() => { cleanup(); fetchBlobUrl.mockClear(); });

describe("DoProofOfDeliveryCard", () => {
  it("shows the run times and loads the POD photo through the DO's own endpoint", async () => {
    wrap({
      id: "do-1", status: "DELIVERED", pod_r2_key: "slips/2026/10/a.jpg",
      departure_at: "2026-10-08T02:00:00Z", arrival_at: "2026-10-08T02:30:00Z", delivered_at: "2026-10-08T02:45:00Z",
    });
    expect(screen.getByText("On the way")).toBeTruthy();
    expect(screen.getByText("Arrived")).toBeTruthy();
    await waitFor(() => expect(screen.getByAltText("Proof of delivery photo")).toBeTruthy());
    expect(fetchBlobUrl).toHaveBeenCalledWith("/api/scm/delivery-orders-mfg/do-1/pod-photo");
  });

  it("says nothing is recorded yet, and asks for no photo, before the crew starts", () => {
    wrap({ id: "do-2", status: "DISPATCHED" });
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
    expect(fetchBlobUrl).not.toHaveBeenCalled();
  });

  it("counts a DO as delivered by its status or its delivered time", () => {
    expect(doIsDelivered({ id: "a", status: "DELIVERED" })).toBe(true);
    expect(doIsDelivered({ id: "b", status: "INVOICED" })).toBe(true);
    expect(doIsDelivered({ id: "c", status: "DISPATCHED", delivered_at: "2026-10-08T02:45:00Z" })).toBe(true);
    expect(doIsDelivered({ id: "d", status: "IN_TRANSIT" })).toBe(false);
  });
});
