/* The DESKTOP Delivery Order edit form reads the same header-lock rule the
 * server refuses on (vendor/shared/do-header-lock.ts, owner ruling 2026-09-14)
 * and sends its header through the same shared body builder the phone uses
 * (vendor/scm/lib/do-header-form.ts).
 *
 * FAILS ON THE PRE-FIX CODE — the form left every field editable on a DO that
 * already had a Sales Invoice, and re-sent the whole header on save.
 *
 * Mounts the REAL page at the real edit URL. Faked: authedFetch (the requests
 * are the assertions) and the two dialog hooks.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { DO_HEADER_LOCKED_NOTICE } from "../../vendor/scm/lib/do-header-form";

afterEach(cleanup);

const DOO = {
  id: "do-1", do_number: "DO-2609-001", status: "DISPATCHED", so_doc_no: "",
  debtor_name: "Alice", debtor_code: "C-1", phone: "+60123456789", email: "a@x.test",
  address1: "1 Jalan Lama", address2: "", customer_state: "Selangor", city: "Petaling Jaya",
  postcode: "46000", sales_location: "PJ", do_date: "2026-09-01", driver_name: "Ali",
  vehicle: "WXX 1", expected_delivery_at: "2026-09-03", customer_delivery_date: "2026-09-02",
  note: "old note", salesperson_id: "", has_children: true,
};
let detail: Record<string, unknown> = DOO;

beforeEach(() => {
  detail = { ...DOO };
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/delivery-orders-mfg/do-1") {
      return { deliveryOrder: detail, items: [{ id: "it-1", item_code: "MAT-1", item_group: "mattress", description: "Mattress", qty: 1 }] };
    }
    if (url.startsWith("/staff/pickable")) return { staff: [] };
    if (url.startsWith("/localities")) return { localities: [] };
    return {};
  });
});

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scm/delivery-orders/new?edit=do-1"]}>
        <DeliveryOrderNewV2 />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const byValue = (v: string) => screen.getByDisplayValue(v) as HTMLInputElement;

describe("DeliveryOrderNewV2 edit — a DO with a live Sales Invoice (owner ruling 2026-09-14)", () => {
  it("says why, disables the locked fields, leaves driver / vehicle open, and sends only the open fields", async () => {
    mount();
    await waitFor(() => expect(byValue("1 Jalan Lama")).toBeTruthy());
    expect(screen.getByText(DO_HEADER_LOCKED_NOTICE)).toBeTruthy();
    for (const v of ["Alice", "1 Jalan Lama", "a@x.test", "old note"]) {
      expect(byValue(v).disabled, `${v} should be locked`).toBe(true);
    }
    for (const v of ["Ali", "WXX 1"]) expect(byValue(v).disabled, `${v} should stay open`).toBe(false);

    await userEvent.clear(byValue("WXX 1"));
    await userEvent.type(screen.getByPlaceholderText("Lorry plate no."), "VBB 2");
    await userEvent.click(screen.getAllByRole("button", { name: "Save changes" })[0]);
    await waitFor(() => expect(authedFetch.mock.calls.some(([u, i]) => u === "/delivery-orders-mfg/do-1" && (i as RequestInit | undefined)?.method === "PATCH")).toBe(true));
    const [, init] = authedFetch.mock.calls.find(([u, i]) => u === "/delivery-orders-mfg/do-1" && (i as RequestInit | undefined)?.method === "PATCH")!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(Object.keys(body).sort()).toEqual(["driverName", "expectedDeliveryAt", "vehicle"]);
    expect(body.vehicle).toBe("VBB 2");
  });

  it("an open DO keeps every field editable", async () => {
    detail = { ...DOO, has_children: false };
    mount();
    await waitFor(() => expect(byValue("1 Jalan Lama")).toBeTruthy());
    expect(screen.queryByText(DO_HEADER_LOCKED_NOTICE)).toBeNull();
    for (const v of ["Alice", "1 Jalan Lama", "a@x.test", "old note", "Ali"]) expect(byValue(v).disabled, v).toBe(false);
  });
});
