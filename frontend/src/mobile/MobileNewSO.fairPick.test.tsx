/* The phone editor records a picked fair EVENT (owner 2026-09-24): 「我选了那个场
 * （Mid Valley，MLE，8 号到 9 号），选了过后，它就自动记下是那个场地的，包括 venue,
 * organiser 和那个日期」. Until then an edit sent the place only and the event the
 * operator picked was thrown away.
 *
 * Same harness as MobileNewSO.fairWindow.test.tsx: the screen is MOUNTED in edit
 * mode with authedFetch faked, and every call it makes is recorded so the test can
 * read the exact header PATCH the Save button sends.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (path === "/mfg-sales-orders/fair-options?date=2026-08-10") return Promise.resolve(FAIRS);
    if (path === "/mfg-sales-orders/validate") return Promise.resolve({ problems: [] });
    if (path === `/mfg-sales-orders/${DOC}/payments`) return Promise.resolve({ payments: [] });
    if (path === `/mfg-sales-orders/${DOC}` && method === "GET") return Promise.resolve(detailBody.current);
    if (path === `/mfg-sales-orders/${DOC}` && method === "PATCH") return Promise.resolve({ ok: true, version: 4 });
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
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

afterEach(() => { cleanup(); vi.mocked(authedFetch).mockClear(); });

const DOC = "HC-SO-2608-010";

/* Two events at MID VALLEY inside the four weeks behind 10 Aug. */
const FAIRS = {
  date: "2026-08-10",
  running: [],
  earlier: [
    { key: "mid valley|mle|2026-08-08|2026-08-09", venue: "MID VALLEY", organizer: "MLE", startDate: "2026-08-08", endDate: "2026-08-09", projectIds: [500, 501] },
    { key: "mid valley|rex|2026-07-24|2026-07-26", venue: "MID VALLEY", organizer: "REX", startDate: "2026-07-24", endDate: "2026-07-26", projectIds: [340] },
  ],
  venues: [{ id: "1", name: "MID VALLEY" }],
};

/* Keyed on 10 Aug at MID VALLEY, linked to the MLE fair. */
const header = {
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-08-10", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  venue: "MID VALLEY", processing_date: null, customer_delivery_date: null, version: 3, currency: "MYR",
  has_children: false, downstream_fully_frozen: false,
  fair: { venue: "MID VALLEY", organizer: "MLE", solo: false, startDate: "2026-08-08", endDate: "2026-08-09" },
};
const item = {
  id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name", qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: null, line_delivery_date_overridden: false, downstream_frozen: false,
};

const mount = () => {
  detailBody.current = { salesOrder: header, items: [item] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} onSaved={() => undefined} />
    </QueryClientProvider>,
  );
};

const fairSelect = (c: HTMLElement) => c.querySelector("#mob-so-fair") as HTMLSelectElement;
const headerPatches = () => vi.mocked(authedFetch).mock.calls
  .filter(([p, init]) => p === `/mfg-sales-orders/${DOC}` && (init as { method?: string } | undefined)?.method === "PATCH")
  .map(([, init]) => JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>);

const openOnMle = async () => {
  const view = mount();
  await waitFor(() => expect(fairSelect(view.container).value).toBe("fair:mid valley|mle|2026-08-08|2026-08-09"));
  return view;
};

describe("phone SO editor — the fair EVENT is recorded, not just the place", () => {
  it("opens on the event the order is linked to", async () => {
    const { container } = await openOnMle();
    expect(fairSelect(container).selectedOptions.item(0)?.textContent).toBe("MID VALLEY — MLE (08/08 - 09/08)");
  });

  it("saving another event sends that event whole — venue, organizer and both dates", async () => {
    const { container } = await openOnMle();
    fireEvent.change(fairSelect(container), { target: { value: "fair:mid valley|rex|2026-07-24|2026-07-26" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(headerPatches()).toHaveLength(1));
    const body = headerPatches()[0]!;
    expect(body).toMatchObject({ fairVenue: "MID VALLEY", fairOrganizer: "REX", fairStart: "2026-07-24", fairEnd: "2026-07-26" });
    /* Same venue, so the venue itself is not re-sent (it would drop the link). */
    expect(body).not.toHaveProperty("venue");
  });

  it("an untouched picker sends no fair keys when something else is saved", async () => {
    await openOnMle();
    fireEvent.change(screen.getByPlaceholderText("Their PO / SO number"), { target: { value: "PO-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(headerPatches()).toHaveLength(1));
    const body = headerPatches()[0]!;
    expect(body).toMatchObject({ customerSoNo: "PO-9" });
    for (const k of ["fairVenue", "fairOrganizer", "fairStart", "fairEnd", "venue"]) expect(body).not.toHaveProperty(k);
  });
});
