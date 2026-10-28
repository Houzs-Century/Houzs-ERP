/* THE PHONE DRAFTS AN INVOICE, IT DOES NOT SEND ONE — owner ruling, 2026-08-20.
 *
 * His words: 「以电脑为准 —— 手机也先出草稿」 — the desktop is the standard, and
 * the phone drafts first too.
 *
 * WHAT WAS WRONG. The wizard's DO→SI arm posted `{ picks }` and nothing else.
 * The route honours `asDraft`, so an absent flag is `status: 'SENT'` with
 * `sent_at` and `confirmed_at` stamped and `invoice_date` forced to today
 * (routes/sales-invoices.ts). Three taps on a phone therefore ISSUED a
 * customer-facing invoice — no due date, no terms, no review, and no way back
 * except cancelling a document the customer may already have seen. The desktop
 * cannot even reach that endpoint: it goes SalesInvoiceFromDo → SalesInvoiceNew
 * with a ~30-key header form, and `useConvertDosToSi` has zero consumers.
 *
 * The GRN arm of this same wizard already had the answer — it sends
 * `asDraft: true` and reasons in its comment about not auto-posting, because
 * posting writes stock. Issuing an invoice writes AR and revenue on confirm, so
 * the same argument holds with money in place of stock. This mirrors that arm
 * rather than inventing a confirmation UX.
 *
 * DRIVEN, NOT GREPPED. This renders the REAL wizard with only `authedFetch`
 * faked and reads the body actually posted, so it covers the click path as well
 * as the literal — a source assertion would pass on a flag that some branch
 * above never reaches.
 *
 * FAILS ON THE PRE-RULING CODE: the SI body carried no `asDraft` at all.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));

import { MobileConvertWizard } from "./MobileConvertWizard";

afterEach(cleanup);
/* Braces, not a concise arrow — a returned mock becomes vitest's teardown. */
beforeEach(() => { authedFetch.mockReset(); });

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

/** Answer the wizard's source list + convertible-lines GETs, then the POST. */
const serveDoToSi = () => {
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/delivery-orders-mfg?limit=200")) {
      return {
        deliveryOrders: [
          { id: "do-1", do_number: "HC-DO-2608-001", status: "DELIVERED", debtor_name: "Walk-in" },
        ],
      };
    }
    if (url.startsWith("/sales-invoices/invoiceable-do-lines")) {
      return {
        lines: [{
          doItemId: "dl-1", doNumber: "HC-DO-2608-001", itemCode: "9028-1A(RHF)",
          description: "9028 SOFA", itemGroup: "sofa", variants: null,
          remaining: 1, unitPriceSen: 250_000, debtorName: "Walk-in",
        }],
      };
    }
    if (url.startsWith("/sales-invoices/from-dos")) return { invoiceNumber: "HC-SI-2608-001" };
    return {};
  });
};

/** The parsed body of the one POST to the convert endpoint. */
const postedBody = (): Record<string, unknown> => {
  const call = authedFetch.mock.calls.find(
    (args: unknown[]) => typeof args[0] === "string" && args[0].startsWith("/sales-invoices/from-dos"),
  );
  expect(call, "the wizard never posted to /sales-invoices/from-dos").toBeTruthy();
  return JSON.parse(String((call![1] as { body?: unknown }).body));
};

describe("MobileConvertWizard — DO → SI drafts, never sends", () => {
  const createDraft = async () => {
    serveDoToSi();
    wrap(
      <MobileConvertWizard
        target="si"
        initialSourceId="do-1"
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    /* Lines arrive pre-ticked, so the operator's three taps really are: open,
       Create, done — which is what made an accidental issue so cheap. */
    const cta = await screen.findByText("Create Sales Invoice");
    await userEvent.click(cta);
    await waitFor(() => expect(postedBody()).toBeTruthy());
  };

  it("sends asDraft so the invoice lands DRAFT, not SENT", async () => {
    await createDraft();
    expect(postedBody().asDraft).toBe(true);
  });

  it("still sends the picked lines — drafting is the only thing that changed", async () => {
    await createDraft();
    expect(postedBody().picks).toEqual([{ doItemId: "dl-1", qty: 1 }]);
  });

  /* The route reads `body.asDraft === true` strictly, so a truthy stand-in
     ("true", 1) would silently issue the invoice. Pin the literal. */
  it("sends a real boolean, which is what the route tests for", async () => {
    await createDraft();
    expect(typeof postedBody().asDraft).toBe("boolean");
  });
});
