/* Editing a Delivery Order's header on the phone (owner 2026-09-12: full desktop
 * parity, same permissions) — and the 2026-09-14 lock once a Sales Invoice or
 * Delivery Return exists.
 *
 * FAILS ON THE PRE-FIX CODE — the screen did not exist; the phone opened DOs
 * read-only.
 *
 * Drives the REAL screen: the real vendored detail + header hooks, the real
 * shared form layer (do-header-form.ts) and lock rule (do-header-lock.ts), the
 * real NotifyProvider. Faked: `authedFetch` (the requests are the assertions) and
 * `useAuth` (the access matrix under test).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch,
}));

const auth = vi.hoisted(() => ({
  levels: {} as Record<string, string>,
  user: { id: 1, email: "o@x.test", name: "O", position_name: "Account Executive", department_name: "Account Department", permissions: [] } as Record<string, unknown>,
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: auth.user, can: () => false, pageAccess: (p: string) => auth.levels[p] ?? "none" }),
}));

import { MobileDoHeaderEdit } from "./MobileDoHeaderEdit";
import { NotifyProvider } from "../vendor/scm/components/NotifyDialog";
import { buildDoHeaderBody, seedDoHeaderForm } from "../vendor/scm/lib/do-header-form";

afterEach(cleanup);

const DOO = {
  id: "do-1", do_number: "DO-2609-001", status: "DISPATCHED",
  debtor_name: "Alice", debtor_code: "C-1", phone: "+60123456789", email: "a@x.test",
  customer_type: "", salesperson_id: "sp-1", address1: "1 Jalan Lama", address2: "",
  customer_state: "Selangor", city: "Petaling Jaya", postcode: "46000", sales_location: "PJ",
  emergency_contact_name: "", emergency_contact_relationship: "", emergency_contact_phone: "",
  do_date: "2026-09-01", driver_name: "Ali", vehicle: "WXX 1", building_type: "", venue: "",
  branding: "Houzs", expected_delivery_at: "2026-09-03", customer_delivery_date: "2026-09-02",
  note: "old note", has_children: false,
};
const ITEMS = [
  { id: "it-1", line_delivery_date: "2026-09-02", line_delivery_date_overridden: false },
  { id: "it-2", line_delivery_date: "2026-09-09", line_delivery_date_overridden: true },
];

let detail: Record<string, unknown> = DOO;
let refusal: Error | null = null;

type Call = { url: string; init?: RequestInit };
const calls = (): Call[] => authedFetch.mock.calls.map(([url, init]) => ({ url: String(url), init }));
const patches = () => calls().filter((c) => c.init?.method === "PATCH");
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body ?? "{}"));

beforeEach(() => {
  detail = { ...DOO };
  refusal = null;
  auth.levels = { "scm.sales.delivery": "edit" };
  authedFetch.mockReset();
  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/delivery-orders-mfg/do-1") return { deliveryOrder: detail, items: ITEMS };
    if (url.startsWith("/staff/pickable")) return { staff: [{ id: "sp-1", name: "Sam", staffCode: "S1" }, { id: "sp-2", name: "Tina", staffCode: "S2" }] };
    if (url.startsWith("/localities")) return { localities: [] };
    if (method === "PATCH" && refusal) throw refusal;
    if (method === "PATCH") return { ok: true };
    return {};
  });
});

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <NotifyProvider>
        <MobileDoHeaderEdit id="do-1" onBack={vi.fn()} onSaved={onSaved} />
      </NotifyProvider>
    </QueryClientProvider>,
  );
  return { onSaved };
};

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("MobileDoHeaderEdit — an open delivery order", () => {
  it("seeds the loaded DO and saves through the SAME header PATCH body the desktop builds", async () => {
    const { onSaved } = mount();
    await waitFor(() => expect(input("Address line 1").value).toBe("1 Jalan Lama"));
    await userEvent.clear(input("Address line 1"));
    await userEvent.type(input("Address line 1"), "9 Jalan Baru");
    await userEvent.clear(input("Driver"));
    await userEvent.type(input("Driver"), "Abu");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const header = patches().filter((c) => c.url === "/delivery-orders-mfg/do-1");
    expect(header).toHaveLength(1);
    const expected = buildDoHeaderBody(
      { ...seedDoHeaderForm(DOO, "2026-09-14"), address1: "9 Jalan Baru", driver: "Abu" },
      [{ id: "sp-1", name: "Sam" }, { id: "sp-2", name: "Tina" }],
      { locked: false },
    );
    expect(bodyOf(header[0])).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("a changed customer delivery date moves the lines that follow the header, not the one typed by hand", async () => {
    const { onSaved } = mount();
    await waitFor(() => expect(input("Customer delivery date").value).not.toBe(""));
    await userEvent.clear(input("Customer delivery date"));
    await userEvent.type(input("Customer delivery date"), "20/09/2026");
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const lines = patches().filter((c) => c.url.includes("/items/"));
    expect(lines.map((c) => c.url)).toEqual(["/delivery-orders-mfg/do-1/items/it-1"]);
    expect(bodyOf(lines[0])).toEqual({ lineDeliveryDate: "2026-09-20", lineDeliveryDateOverridden: false });
  });

  it("a server refusal reaches the operator in the server's own words, and the screen stays", async () => {
    refusal = new Error("The customer on this Delivery Order is already reflected in a Sales Invoice.");
    const { onSaved } = mount();
    await waitFor(() => expect(input("Customer name").value).toBe("Alice"));
    await userEvent.type(input("Customer name"), " Tan");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/already reflected in a Sales Invoice/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("MobileDoHeaderEdit — locked by a Sales Invoice (owner ruling 2026-09-14)", () => {
  it("disables exactly the fields the server locks, and sends only the open ones", async () => {
    detail = { ...DOO, has_children: true };
    const { onSaved } = mount();
    expect(await screen.findByText(/Sales Invoice or Delivery Return already exists/)).toBeTruthy();
    for (const l of ["Customer name", "Phone", "Email", "Address line 1", "Address line 2",
      "Emergency contact name", "Emergency contact phone", "DO date", "Customer delivery date", "Note", "Venue"]) {
      expect(input(l).disabled, `${l} should be locked`).toBe(true);
    }
    for (const l of ["Driver", "Vehicle", "Expected delivery"]) {
      expect(input(l).disabled, `${l} should stay open`).toBe(false);
    }
    await userEvent.clear(input("Vehicle"));
    await userEvent.type(input("Vehicle"), "VBB 2");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const header = patches().filter((c) => c.url === "/delivery-orders-mfg/do-1");
    expect(Object.keys(bodyOf(header[0])).sort()).toEqual(["driverName", "expectedDeliveryAt", "vehicle"]);
    expect(bodyOf(header[0]).vehicle).toBe("VBB 2");
  });
});

describe("MobileDoHeaderEdit — who may edit", () => {
  it("a view-only holder gets no form and no save — the desktop's canOperateDeliveryOrders", async () => {
    auth.levels = { "scm.sales.delivery": "view" };
    mount();
    expect(await screen.findByText(/cannot edit delivery orders/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(patches()).toHaveLength(0);
  });
});
