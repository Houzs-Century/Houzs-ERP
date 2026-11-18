/* DO From SO -> New DO: "Save as Draft" beside "Create Delivery Order"
 * (owner 2026-11-18: the goods are not in yet, so the DO is opened as a draft;
 * the office presses Confirm once the GR is done). Save as Draft must send
 * `asDraft: true` — the only field the create route reads to park a DO — and
 * Create must not, or it would be parked instead of shipped.
 *
 * Mounts the REAL page on the From-SO hand-off URL. Faked: authedFetch and the
 * dialog hooks.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeScmHandoff } from "../../lib/scmHandoffStorage";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../../lib/storageIdentity";

const { authedFetch, notify } = vi.hoisted(() => ({ authedFetch: vi.fn(), notify: vi.fn() }));
vi.mock("../../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, permissions: ["*"] }, can: () => true, pageAccess: () => "full" }),
}));

import { DeliveryOrderNewV2 } from "./DeliveryOrderNewV2";

const posted = () => authedFetch.mock.calls
  .filter(([url, init]) => url === "/delivery-orders-mfg" && (init as RequestInit | undefined)?.method === "POST")
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/delivery-orders-mfg/so-source/")) {
      return { source: { customerName: "Tan Ah Kow", debtorCode: "C1" }, missing: [] };
    }
    if (url === "/delivery-orders-mfg" && init?.method === "POST") return { id: "do-new", doNumber: "HC-DO-1" };
    if (url.startsWith("/staff/pickable")) return { staff: [] };
    if (url.startsWith("/localities")) return { localities: [] };
    return {};
  });
  bindBrowserStorageIdentity(1);
  writeScmHandoff("doFromSoPicks", [{
    soItemId: "soi-1", docNo: "HC-SO-1", itemCode: "MAT-1", itemGroup: "mattress", description: "Mattress", uom: "UNIT", qty: 2,
  }]);
});
afterEach(() => { cleanup(); clearBrowserStorageIdentity(); });

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scm/delivery-orders/new?fromSo=HC-SO-1&fromPicks=1"]}>
        <DeliveryOrderNewV2 />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("New DO from SO — Save as Draft", () => {
  it("Save as Draft posts asDraft: true", async () => {
    mount();
    await screen.findByDisplayValue("Tan Ah Kow");
    fireEvent.click(screen.getAllByRole("button", { name: /Save as Draft/ })[0]!);
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ asDraft: true, soDocNo: "HC-SO-1" });
  });

  it("Create Delivery Order does not send asDraft", async () => {
    mount();
    await screen.findByDisplayValue("Tan Ah Kow");
    fireEvent.click(screen.getAllByRole("button", { name: /Create Delivery Order/ })[0]!);
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]!.asDraft).toBeUndefined();
  });
});
