/* Adrian (2026-10-09, after DEV-61): on the phone, Qty opens the number pad
 * but Unit Price opened the letter keyboard, so a price had to be typed through
 * the "123" key. Money fields on the phone SO editor ask for the decimal pad.
 *
 * Harness copied from MobileNewSO.savedVenue.test.tsx (an edit-mode mount with
 * one saved line).
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody, me } = vi.hoisted(() => ({
  detailBody: { current: null as unknown },
  me: { venueId: null as string | null },
}));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (path.startsWith("/mfg-sales-orders/fair-options")) return Promise.resolve({ date: "2026-09-20", running: [], earlier: [], venues: [] });
    if (path === `/mfg-sales-orders/${DOC}/payments`) return Promise.resolve({ payments: [] });
    if (path === `/mfg-sales-orders/${DOC}`) return Promise.resolve(detailBody.current);
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/lib/venues-queries", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/venues-queries")>()),
  useVenues: () => ({ data: VENUES, isLoading: false, isError: false }),
}));
vi.mock("../vendor/scm/lib/admin-queries", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/admin-queries")>()),
  usePickableStaff: () => ({ data: STAFF, isLoading: false, isError: false }),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: { id: "S9", role: "sales", name: "Me", staffCode: "S9", venueId: me.venueId }, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";

afterEach(() => { cleanup(); me.venueId = null; });

const DOC = "2990-SO-2609-014";

const venue = (id: string, name: string) => ({ id, name, address: null, state: null, active: true, created_at: "2026-01-01", origin: "PROJECT", warehouseId: null });
const VENUES = [venue("V-DEFAULT", "PJ SHOWROOM"), venue("107", "2990s PJ")];
const staff = (id: string, venueId: string | null) => ({
  id, staffCode: id, name: id, role: "sales", showroomId: null, venueId, initials: id, color: "#000", active: true, userId: null, email: null, phone: null,
});
/* S1 is Scarlett's shape on production: a default venue of her own. */
const STAFF = [staff("S1", "V-DEFAULT"), staff("S2", null)];

const header = (o: { venue: string | null; salesperson_id: string }) => ({
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-09-20", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  venue_id: null, processing_date: null, customer_delivery_date: null, version: 3, currency: "MYR",
  has_children: false, downstream_fully_frozen: false, ...o,
});
const item = {
  id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name", qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: null, line_delivery_date_overridden: false, downstream_frozen: false,
};

const mountEdit = (so: ReturnType<typeof header>) => {
  detailBody.current = { salesOrder: so, items: [item] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} />
    </QueryClientProvider>,
  );
};

describe("phone SO editor — money fields open the number pad", () => {
  it("Unit Price asks for the decimal keypad", async () => {
    const { container } = mountEdit(header({ venue: null, salesperson_id: "S1" }));
    await waitFor(() => expect(container.querySelector("input.money")).not.toBeNull());
    const money = [...container.querySelectorAll<HTMLInputElement>("input.money")];
    for (const input of money) expect(input.inputMode).toBe("decimal");
  });
});
