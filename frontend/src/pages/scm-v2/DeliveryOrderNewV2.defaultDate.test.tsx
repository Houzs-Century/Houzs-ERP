/* A new Delivery Order opens with today's date as its DO date, and today is
 * the MALAYSIAN day (owner 2026-11-09). The form used to read the device's own
 * clock, so between 00:00 and 08:00 in Malaysia a machine on UTC — or a laptop
 * abroad — dated the DO yesterday.
 *
 * Mounts the REAL page at the real new-DO URL. Faked: authedFetch and the two
 * dialog hooks.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "full" }),
}));

import { DeliveryOrderNewV2 } from "./DeliveryOrderNewV2";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 01:30 on 10 November in Malaysia; still the 9th in UTC.
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z"));
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/staff/pickable")) return { staff: [] };
    if (url.startsWith("/localities")) return { localities: [] };
    return {};
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("DeliveryOrderNewV2 — new DO date", () => {
  it("defaults to the Malaysian day", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scm/delivery-orders/new"]}>
          <DeliveryOrderNewV2 />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const label = await screen.findByText("DO date");
    expect(within(label.parentElement!).getByDisplayValue("2026/11/10")).toBeTruthy();
  });
});
