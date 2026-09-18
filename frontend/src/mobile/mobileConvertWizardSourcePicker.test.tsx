/* WHICH SOURCE DOCUMENTS THE PHONE'S CONVERT WIZARD OFFERS. docs/bugs/0888.
 *
 * Step 1 of the wizard lists the documents a new one may be raised from. The
 * Sales Order arm (targets "do" and "po") filtered Sales Orders with the
 * DELIVERY ORDER status set — LOADED / DISPATCHED / IN_TRANSIT / SIGNED /
 * DELIVERED — and a Sales Order only ever shares one of those words, so a
 * CONFIRMED order waiting for its delivery was never offered. The other wizard
 * tests pass `initialSourceId`, which skips this step entirely, so none of them
 * could see it.
 *
 * The expected sets below are the CREATE gates' own rules, not a copy chosen to
 * make this pass: `soCanRaiseDo` (DO gate `firstUndeliverableSo`; the PO gate's
 * set is pinned equal) and `SI_TRANSFERABLE_DO_STATES` (SI gate).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));

import { MobileConvertWizard } from "./MobileConvertWizard";

afterEach(cleanup);
beforeEach(() => { authedFetch.mockReset(); });

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const so = (docNo: string, status: string, onHold: boolean | null = false) => ({
  doc_no: docNo, debtor_name: `Customer ${docNo}`, status, on_hold: onHold,
  so_date: "2026-09-01", local_total_sen: 100000, total_revenue_sen: 100000,
});

const SALES_ORDERS = [
  so("SO-CONFIRMED", "CONFIRMED"),
  so("SO-IN-PRODUCTION", "IN_PRODUCTION"),
  so("SO-READY", "READY_TO_SHIP"),
  so("SO-DELIVERED", "DELIVERED"),
  so("SO-DRAFT", "DRAFT"),
  so("SO-CANCELLED", "CANCELLED"),
  so("SO-CLOSED", "CLOSED"),
  so("SO-LEGACY-HOLD", "ON_HOLD"),
  so("SO-HELD", "CONFIRMED", true),
];
const OFFERED_SO = ["SO-CONFIRMED", "SO-IN-PRODUCTION", "SO-READY", "SO-DELIVERED"];
const REFUSED_SO = ["SO-DRAFT", "SO-CANCELLED", "SO-CLOSED", "SO-LEGACY-HOLD", "SO-HELD"];

const doRow = (doNumber: string, status: string) => ({
  id: `id-${doNumber}`, do_number: doNumber, debtor_name: `Customer ${doNumber}`, status,
  do_date: "2026-09-01", local_total_sen: 100000,
});

function fakeLists() {
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/mfg-sales-orders?limit=200")) return { salesOrders: SALES_ORDERS };
    if (url.startsWith("/delivery-orders-mfg?limit=200")) {
      return {
        deliveryOrders: [
          doRow("DO-LOADED", "LOADED"),
          doRow("DO-DISPATCHED", "DISPATCHED"),
          doRow("DO-DRAFT", "DRAFT"),
          doRow("DO-CANCELLED", "CANCELLED"),
        ],
      };
    }
    return {};
  });
}

async function expectOffered(offered: string[], refused: string[]) {
  expect(await screen.findByText(offered[0])).toBeTruthy();
  for (const doc of offered) expect(screen.queryByText(doc), `${doc} should be offered`).not.toBeNull();
  for (const doc of refused) expect(screen.queryByText(doc), `${doc} should not be offered`).toBeNull();
}

describe("MobileConvertWizard step 1 — the Sales Order arm", () => {
  it("SO -> DO offers the orders a delivery may be raised from, not only delivered ones", async () => {
    fakeLists();
    wrap(<MobileConvertWizard target="do" onBack={() => {}} onCreated={() => {}} />);
    await expectOffered(OFFERED_SO, REFUSED_SO);
  });

  it("SO -> PO offers the same orders (the PO gate's set is pinned equal)", async () => {
    fakeLists();
    wrap(<MobileConvertWizard target="po" onBack={() => {}} onCreated={() => {}} />);
    await expectOffered(OFFERED_SO, REFUSED_SO);
  });
});

describe("MobileConvertWizard step 1 — the Delivery Order arm is unchanged", () => {
  it("DO -> SI still offers only transferable delivery orders", async () => {
    fakeLists();
    wrap(<MobileConvertWizard target="si" onBack={() => {}} onCreated={() => {}} />);
    await expectOffered(["DO-LOADED", "DO-DISPATCHED"], ["DO-DRAFT", "DO-CANCELLED"]);
  });
});
