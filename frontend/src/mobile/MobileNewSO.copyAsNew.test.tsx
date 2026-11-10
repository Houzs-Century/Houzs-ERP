/* HC-0149 Copy as new on the phone: the detail's "Copy as new" opens New SO with
 * the source order as `convertFrom.copyFrom` and no picks. The draft is the one
 * the desktop's ?copyFrom= form builds for the same order: both read
 * soCopyHeaderSeed + copySeedLines (lib/soCopyLines), so this pins the phone
 * screen to that seed field by field — customer, address (city / postcode from
 * address3 / address4 on an older order), emergency contact, note, salesperson;
 * no Ref No., no dates; a PWP reward line left out.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody, notified } = vi.hoisted(() => ({ detailBody: { current: null as unknown }, notified: [] as unknown[] }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (/\/mfg-sales-orders\/[^/?]+$/.test(path)) return Promise.resolve(detailBody.current);
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => (n: unknown) => { notified.push(n); } }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";
import { soCopyHeaderSeed, copySeedLines } from "../lib/soCopyLines";

afterEach(() => { cleanup(); notified.length = 0; });

const SRC = "HC-SO-2610-044";
const source = {
  doc_no: SRC, status: "CONFIRMED", so_date: "2026-10-01", debtor_code: "C-77", debtor_name: "Lim Mei Hua", phone: "+60123456789",
  email: "lim@example.com", customer_type: "Existing Customer", building_type: "Condo", note: "Call before delivery",
  address1: "12 Jalan Bunga", address2: "Taman Mawar", address3: "Shah Alam", address4: "40000",
  customer_state: "Selangor", city: null, postcode: null, customer_so_no: "PO-991", ref: "R-1",
  emergency_contact_name: "Lim Ah Kow", emergency_contact_relationship: "Spouse", emergency_contact_phone: "+60198765432",
  processing_date: "2026-10-05", customer_delivery_date: "2026-10-20", version: 5, currency: "MYR", salesperson_id: null,
  has_children: false, downstream_fully_frozen: false,
};
const item = (id: string, code: string, variants: Record<string, unknown>) => ({
  id, doc_no: SRC, item_group: "mattress", item_code: code, description: `${code} name`, qty: 2, unit_price_sen: 150_000,
  discount_sen: 0, variants, remark: null, cancelled: false, line_delivery_date: "2026-10-20", downstream_frozen: false,
  photo_urls: ["so/src/photo.jpg"],
});
const ITEMS = [item("l1", "MT-QUEEN", {}), item("l2", "PILLOW-PWP", { pwp: true, pwpCode: "PWP-9" })];

describe("phone Copy as new", () => {
  it("builds the desktop copy's draft for the same order", async () => {
    detailBody.current = { salesOrder: source, items: ITEMS };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MobileNewSO mode="new" openAddLine={false} onBack={() => undefined} convertFrom={{ copyFrom: SRC, picks: [] }} />
      </QueryClientProvider>,
    );
    const seed = soCopyHeaderSeed(source);
    await waitFor(() => expect(screen.getByDisplayValue(seed.debtorName)).toBeTruthy());
    for (const v of [seed.email, seed.note, seed.address1, seed.address2, seed.emergencyName]) expect(screen.getByDisplayValue(v)).toBeTruthy();
    /* An older order kept the city and postcode in address3 / address4: the copy falls back to them, as on desktop. */
    expect(seed.city).toBe("Shah Alam");
    expect(seed.postcode).toBe("40000");
    /* Never the refs or the dates: a clean draft. */
    expect(screen.queryByDisplayValue("PO-991")).toBeNull();
    expect(screen.queryByDisplayValue("R-1")).toBeNull();
    expect(screen.queryByDisplayValue("2026-10-20")).toBeNull();
    /* The lines are copySeedLines' lines: the PWP reward left out, and the operator told. */
    const kept = copySeedLines(ITEMS, source.status, () => undefined).map((i) => i.item_code);
    expect(kept).toEqual(["MT-QUEEN"]);
    expect(container.textContent).toContain("MT-QUEEN");
    expect(container.textContent).not.toContain("PILLOW-PWP");
    expect(notified).toHaveLength(1);
    expect((container.querySelector('input[aria-label="Qty"]') as HTMLInputElement).value).toBe("2"); // the qty came across
  });
});
