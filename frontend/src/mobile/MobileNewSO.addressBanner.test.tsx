/* The phone SO editor's delivery-address banner (owner 2026-09-16).
 *
 * Owner sighting on the mobile "Edit Sales Order": the amber warning "the full
 * delivery address (State, City, Postcode and Address Line 1) is required"
 * showed even though State / City / Postcode / Address Line 1 were ALL filled,
 * and the order would not save — a complete address reported as incomplete.
 *
 * Root cause: the banner rendered on `addressRequired` (a Processing Date is
 * present) ALONE, ignoring whether the address was actually short. The save
 * gate (missingAddress) read the four filled fields correctly the whole time;
 * the banner was the false alarm. It now renders only when a field is genuinely
 * missing, and names what is missing.
 *
 * MobileNewSO is MOUNTED in edit mode under a real QueryClient (same harness as
 * MobileNewSO.frozenLines.test.tsx): it loads the order through authedFetch, so
 * that one module is faked; every other request stays pending.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (/\/mfg-sales-orders\/[^/?]+\/payments$/.test(path)) return Promise.resolve({ payments: [] });
    if (/\/mfg-sales-orders\/[^/?]+$/.test(path)) return Promise.resolve(detailBody.current);
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";

afterEach(cleanup);

const DOC = "HC-SO-2609-777";

/* A future Processing Date makes the address required (addressRequired = true)
   without tripping the processing-date lock (which fires only on a PAST date),
   so the address card stays editable and the banner logic is exercised. */
const baseHeader = {
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-09-01", debtor_name: "Goh", phone: "+60123456789",
  email: "g@h.c", address1: "268, Lorong Permata 10,", address2: "PERMATA HILL PARK",
  customer_state: "Kedah", city: "Sungai Petani", postcode: "08000",
  processing_date: "2026-12-01", customer_delivery_date: "2026-12-15",
  version: 3, currency: "MYR", has_children: false, downstream_fully_frozen: false,
};

const line = {
  id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name",
  qty: 1, unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: "2026-12-15", downstream_frozen: false,
};

const mount = (so: Record<string, unknown>) => {
  detailBody.current = { salesOrder: so, items: [line] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} />
    </QueryClientProvider>,
  );
};

const BANNER = /delivery address is required/i;

describe("phone SO editor — the standing delivery-address banner is GONE", () => {
  /* Owner 2026-09-16: remove the banner entirely — it is noise now. A missing
     address surfaces the same way as every other blocker: the field `*` + red
     mark, a line in the backend all-at-once problems list, and the persistent
     "Can't save — N to fix" pill by Save. The address RULE is unchanged (still
     enforced by the backend collector); only the standing banner is gone. */
  it("shows no banner when the address is complete", async () => {
    mount(baseHeader);
    await waitFor(() => expect(screen.getByDisplayValue("268, Lorong Permata 10,")).toBeTruthy());
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("shows no banner even when a required address field is empty (it was removed)", async () => {
    mount({ ...baseHeader, postcode: null });
    await waitFor(() => expect(screen.getByDisplayValue("268, Lorong Permata 10,")).toBeTruthy());
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});
