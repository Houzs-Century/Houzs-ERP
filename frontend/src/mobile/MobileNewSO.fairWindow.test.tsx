/* Backfilling the fair on an order written weeks ago (owner 2026-09-23):
 * 「如果这个 sales order 是上个月 2 号开的……选项应该显示上个月 2 号往前推四个星期的
 * event，而不是从现在往前推四个星期」.
 *
 * The phone editor asked the server for TODAY's four weeks on every order, so an
 * order keyed on 2 Aug offered late-September fairs and never the one it was
 * written at. Same harness as MobileNewSO.frozenLines.test.tsx: the screen is
 * MOUNTED with authedFetch faked, and the fake answers each window with a
 * different fair, so the rows on screen say which window was asked for.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detailBody } = vi.hoisted(() => ({ detailBody: { current: null as unknown } }));

vi.mock("../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (path === "/mfg-sales-orders/fair-options?date=2026-08-02") return Promise.resolve(fairList("2026-08-02", AUG_FAIR));
    if (path === "/mfg-sales-orders/fair-options") return Promise.resolve(fairList("2026-09-23", SEP_FAIR));
    if (path === `/mfg-sales-orders/${DOC}/payments`) return Promise.resolve({ payments: [] });
    if (path === `/mfg-sales-orders/${DOC}`) return Promise.resolve(detailBody.current);
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

const DOC = "HC-SO-2608-002";

/* Closed a week before the order was keyed: inside 2 Aug's window, long gone from today's. */
const AUG_FAIR = { key: "aug", venue: "MID VALLEY", organizer: "BIGHOME", startDate: "2026-07-24", endDate: "2026-07-26", projectIds: [11] };
/* Inside today's window only. */
const SEP_FAIR = { key: "sep", venue: "IOI CITY MALL", organizer: "HOMELOVE", startDate: "2026-09-18", endDate: "2026-09-20", projectIds: [12] };
const fairList = (date: string, fair: typeof AUG_FAIR) => ({ date, running: [], earlier: [fair], venues: [] });

/* Keyed on 2 Aug with no venue — the order the owner comes back to fill in. */
const header = {
  doc_no: DOC, status: "CONFIRMED", so_date: "2026-08-02", debtor_name: "Ada", phone: "+60123456789",
  email: "a@b.c", address1: "1 Jalan", customer_state: "Selangor", city: "Shah Alam", postcode: "40000",
  venue: null, processing_date: null, customer_delivery_date: null, version: 3, currency: "MYR",
  has_children: false, downstream_fully_frozen: false,
};
const item = {
  id: "line-1", doc_no: DOC, item_group: "mattress", item_code: "MT-QUEEN", description: "MT-QUEEN name", qty: 1,
  unit_price_sen: 100000, discount_sen: 0, variants: {}, remark: null, cancelled: false,
  line_delivery_date: null, line_delivery_date_overridden: false, downstream_frozen: false,
};

const mount = (mode: "new" | "edit") => {
  detailBody.current = { salesOrder: header, items: [item] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileNewSO mode={mode} docNo={mode === "edit" ? DOC : undefined} openAddLine={false} onBack={() => undefined} />
    </QueryClientProvider>,
  );
};

const fairRows = (container: HTMLElement) =>
  Array.from((container.querySelector("#mob-so-fair") as HTMLSelectElement | null)?.options ?? []).map((o) => o.textContent);

describe("phone SO fair list — the four weeks behind the ORDER's date", () => {
  it("an existing order offers the fairs of the four weeks before its own date, not today's", async () => {
    const { container } = mount("edit");
    await waitFor(() => expect(fairRows(container).some((t) => t.startsWith("MID VALLEY — BIGHOME"))).toBe(true));
    expect(fairRows(container).some((t) => t.startsWith("IOI CITY MALL"))).toBe(false);
    expect(vi.mocked(authedFetch).mock.calls.map(([p]) => p)).not.toContain("/mfg-sales-orders/fair-options");
  });

  it("a new order still offers today's four weeks — the server dates it today", async () => {
    const { container } = mount("new");
    await waitFor(() => expect(fairRows(container).some((t) => t.startsWith("IOI CITY MALL — HOMELOVE"))).toBe(true));
    expect(fairRows(container).some((t) => t.startsWith("MID VALLEY"))).toBe(false);
  });
});
