/* A SCANNED draft cannot be confirmed without a fair or No fair (owner
 * 2026-10-19), and the phone's Edit Draft is where the rep says which. The No
 * fair tick used to show on a NEW order only, so a genuine showroom sale that
 * came in by scan had no way out. These pin the draft half:
 *
 *   - a DRAFT with no fair event offers the tick, and saving sends noFair;
 *   - a draft already marked NO_FAIR opens with it ticked;
 *   - a CONFIRMED order does not offer it (re-assigning is Finance / PMS's job).
 *
 * Same harness as MobileNewSO.fairPick.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (path.startsWith("/mfg-sales-orders/fair-options")) return Promise.resolve(FAIRS);
    if (path === "/mfg-sales-orders/validate") return Promise.resolve({ problems: [] });
    if (path === `/mfg-sales-orders/${DOC}/payments`) return Promise.resolve({ payments: [] });
    if (path === `/mfg-sales-orders/${DOC}` && method === "GET") return Promise.resolve(detailBody.current);
    if (path === `/mfg-sales-orders/${DOC}` && method === "PATCH") return Promise.resolve({ ok: true, version: 4 });
    return new Promise(() => undefined);
  }),
}));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, name: "Owner" }, can: () => true }) }));
vi.mock("../vendor/scm/lib/auth", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/auth")>()),
  useAuth: () => ({ staff: null, user: null }),
}));

import { MobileNewSO } from "./MobileNewSO";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";

afterEach(() => { cleanup(); vi.mocked(authedFetch).mockClear(); });

const DOC = "HC-SO-2610-300";
const FAIRS = { date: "2026-10-19", running: [], earlier: [], venues: [{ id: "9", name: "ZANOTTI LIVING (KELANA JAYA)" }] };

/* A scan draft written at a showroom: a place, no fair event. */
const draft = {
  doc_no: DOC, status: "DRAFT", so_date: "2026-10-19", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  venue: "ZANOTTI LIVING (KELANA JAYA)", processing_date: null, customer_delivery_date: null, version: 3, currency: "MYR",
  has_children: false, downstream_fully_frozen: false, fair: null, fair_match: "PENDING",
};
const item = {
  id: "line-1", doc_no: DOC, item_group: "sofa", item_code: "SF-1", description: "SF-1", qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: null, line_delivery_date_overridden: false, downstream_frozen: false,
};

const mount = (salesOrder: Record<string, unknown>) => {
  detailBody.current = { salesOrder, items: [item] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode="edit" docNo={DOC} openAddLine={false} onBack={() => undefined} onSaved={() => undefined} />
    </QueryClientProvider>,
  );
};

const noFairBox = () => screen.queryByRole("checkbox", { name: /No fair/ }) as HTMLInputElement | null;
const headerPatches = () => vi.mocked(authedFetch).mock.calls
  .filter(([p, init]) => p === `/mfg-sales-orders/${DOC}` && (init as { method?: string } | undefined)?.method === "PATCH")
  .map(([, init]) => JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>);

describe("phone Edit Draft — No fair on a scanned draft (owner 2026-10-19)", () => {
  it("a draft with no fair event offers No fair, and saving sends it", async () => {
    mount(draft);
    await waitFor(() => expect(noFairBox()).not.toBeNull());
    fireEvent.click(noFairBox()!);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(headerPatches()).toHaveLength(1));
    expect(headerPatches()[0]).toMatchObject({ noFair: true });
  });

  it("a draft already marked No fair opens with it ticked", async () => {
    mount({ ...draft, fair_match: "NO_FAIR" });
    await waitFor(() => expect(noFairBox()?.checked).toBe(true));
  });

  it("a confirmed order does not offer it", async () => {
    mount({ ...draft, status: "CONFIRMED" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy());
    expect(noFairBox()).toBeNull();
  });
});
