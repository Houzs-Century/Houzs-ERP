/* A venue already SAVED on an order is what the phone editor shows (owner
 * 2026-06-23: "never override a manual or loaded pick"). A saved venue with no
 * venue_id — 3,219 of 3,242 live orders on 2026-09-24 — used to rank BELOW the
 * salesperson's default venue, and the signed-in user's own default could seed
 * the picker before the order had even loaded. Dormant in production only
 * because those default ids (scm.venues) match nothing in the picker's list;
 * here they DO match, which is the case the fix is for.
 *
 * Same harness as MobileNewSO.fairWindow.test.tsx, plus the venue master and the
 * salesperson list, so a default can actually resolve.
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
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
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

const shownPlace = (c: HTMLElement) =>
  (c.querySelector("#mob-so-fair") as HTMLSelectElement | null)?.selectedOptions.item(0)?.textContent ?? null;

describe("phone SO editor — the saved venue is the venue", () => {
  it("keeps the order's own venue, not the salesperson's default", async () => {
    const { container } = mountEdit(header({ venue: "2990s PJ", salesperson_id: "S1" }));
    await waitFor(() => expect(shownPlace(container)).toBe("2990s PJ"));
  });

  it("keeps it against the signed-in user's own default, known before the order loads", async () => {
    me.venueId = "V-DEFAULT";
    const { container } = mountEdit(header({ venue: "2990s PJ", salesperson_id: "S2" }));
    await waitFor(() => expect(shownPlace(container)).toBe("2990s PJ"));
  });

  it("an order with no venue still takes the salesperson's default", async () => {
    const { container } = mountEdit(header({ venue: null, salesperson_id: "S1" }));
    await waitFor(() => expect(shownPlace(container)).toBe("PJ SHOWROOM"));
  });
});
