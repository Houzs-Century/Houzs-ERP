/* The MOBILE convert wizard is the phone's ONLY create-by-convert surface for
 * Delivery Order, Sales Invoice, Goods Receipt and Purchase Order — the whole
 * chain the owner walks. Every one of its line rows printed
 * `description || itemCode` and nothing else, so a sofa's three modules
 * (9028-1A(LHF) / 9028-1A(RHF) / 9028-1NA) arrived on the phone as three rows
 * with the same words on them.
 *
 * "只要有 variants 的，你就应该要显示 variants" — owner, 2026-08-19. A fix that
 * lands on the desktop picker and not here reproduces the exact defect class
 * this repo has been closing all week, so the phone gets its own assertion.
 *
 * These drive the REAL wizard with only `authedFetch` faked, so the assertion
 * covers the map AND the render: the endpoints already return itemGroup +
 * variants (verified in the handlers, see the wizard's own header comment) and
 * the bug was purely that the map dropped them.
 *
 * FAILS ON THE PRE-FIX CODE — `PickLine` had no variant field at all.
 */
import { cleanup, render, screen } from "@testing-library/react";
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

/* The variant bag a sofa module carries. buildVariantSummary renders it as
   `PC151-01 Pearl / SEAT 24" / LEG 6"`. */
const SOFA = { fabricCode: "PC151-01", colourLabel: "Pearl", seatHeight: '24"', legHeight: '6"' };
const SOFA_SUMMARY = 'PC151-01 Pearl / SEAT 24" / LEG 6"';
/* A bedframe takes the OTHER branch of buildVariantSummary (divan/leg/gap), so
   asserting on it proves the wizard passes the real item_group through rather
   than a hardcoded one — a wrong group silently renders the wrong summary. */
const BEDFRAME = { fabricCode: "BF-01", colourLabel: "Sand", divanHeight: '10"', legHeight: '1"', gap: '2"' };
const BEDFRAME_SUMMARY = 'BF-01 Sand / DIVAN 10" + LEG 1" / GAP 2"';

/** Answer the wizard's two GETs: the source list, then the convertible lines. */
const serve = (sourceKey: string, sources: unknown[], linesKey: string, lines: unknown) => {
  authedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith(sourceKey)) return { [sourceKey === "/mfg-sales-orders?limit=200" ? "salesOrders" : "deliveryOrders"]: sources };
    if (url.startsWith(linesKey)) return lines;
    return {};
  });
};

describe("MobileConvertWizard — SO → DO", () => {
  it("prints each sofa module's variant summary under its name", async () => {
    serve(
      "/mfg-sales-orders?limit=200",
      [{ doc_no: "HC-SO-2608-001", status: "OPEN", debtor_name: "Walk-in" }],
      "/delivery-orders-mfg/deliverable-so-lines",
      {
        lines: [
          {
            soItemId: "sl-1", docNo: "HC-SO-2608-001", itemCode: "9028-1A(LHF)",
            description: "9028 SOFA", itemGroup: "sofa", variants: SOFA,
            qty: 2, remaining: 2, unitPriceSen: 0, debtorName: "Walk-in",
          },
          {
            soItemId: "sl-2", docNo: "HC-SO-2608-001", itemCode: "BF-CODY",
            description: "CODY BEDFRAME", itemGroup: "bedframe", variants: BEDFRAME,
            qty: 1, remaining: 1, unitPriceSen: 0, debtorName: "Walk-in",
          },
        ],
      },
    );

    wrap(
      <MobileConvertWizard
        target="do"
        initialSourceId="HC-SO-2608-001"
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    expect(await screen.findByText(SOFA_SUMMARY)).toBeTruthy();
    // The bedframe branch, from the SAME row's real item_group.
    expect(screen.getByText(BEDFRAME_SUMMARY)).toBeTruthy();
  });
});

describe("MobileConvertWizard — SO → PO", () => {
  it("prints the variant summary on the line being purchased", async () => {
    serve(
      "/mfg-sales-orders?limit=200",
      [{ doc_no: "HC-SO-2608-001", status: "OPEN", debtor_name: "Walk-in" }],
      "/mfg-purchase-orders/outstanding-so-items",
      {
        items: [{
          soItemId: "sl-1", soDocNo: "HC-SO-2608-001", itemCode: "9028-1A(LHF)",
          description: "9028 SOFA", itemGroup: "sofa", variants: SOFA,
          qty: 2, poQtyPicked: 0, remainingQty: 2, unitPriceSen: 0,
        }],
      },
    );

    wrap(
      <MobileConvertWizard
        target="po"
        initialSourceId="HC-SO-2608-001"
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    expect(await screen.findByText(SOFA_SUMMARY)).toBeTruthy();
  });
});

describe("MobileConvertWizard — DO → SI", () => {
  it("prints the variant summary on the line being invoiced", async () => {
    serve(
      "/delivery-orders-mfg?limit=200",
      [{ id: "do-1", do_number: "HC-DO-2608-001", status: "DELIVERED", debtor_name: "Walk-in" }],
      "/sales-invoices/invoiceable-do-lines",
      {
        lines: [{
          doItemId: "dl-1", doNumber: "HC-DO-2608-001", itemCode: "9028-1A(RHF)",
          description: "9028 SOFA", itemGroup: "sofa", variants: SOFA,
          remaining: 1, unitPriceSen: 0, debtorName: "Walk-in",
        }],
      },
    );

    wrap(
      <MobileConvertWizard
        target="si"
        initialSourceId="do-1"
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    expect(await screen.findByText(SOFA_SUMMARY)).toBeTruthy();
  });
});

describe("MobileConvertWizard — PO → GRN", () => {
  /* Receiving is where getting the module wrong costs the most: stock lands
     against a code whose variants nobody checked, and the GRN is what the
     Purchase Invoice is then billed from. The GRN row already CARRIED
     itemGroup + variants (the create needs them); only the render dropped them. */
  it("prints the variant summary on the line being received", async () => {
    authedFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/mfg-purchase-orders?limit=200")) {
        return {
          purchaseOrders: [{
            id: "po-1", po_number: "HC-PO-2608-001", status: "SUBMITTED",
            po_date: "2026-08-17", total_sen: 0,
            supplier: { id: "sup-1", code: "400-H004", name: "HOOKKA INDUSTRIES SDN. BHD." },
          }],
        };
      }
      if (url.startsWith("/grns/outstanding-po-items")) {
        return {
          items: [{
            poItemId: "poi-1", poId: "po-1", poDocNo: "HC-PO-2608-001", supplierId: "sup-1",
            itemCode: "9028-1NA", supplierSku: null, description: "9028 SOFA",
            itemGroup: "sofa", variants: SOFA,
            qty: 3, receivedQty: 0, remainingQty: 3, unitPriceSen: 0,
            deliveryDate: null, warehouseLocationId: "wh-1",
          }],
        };
      }
      return {};
    });

    wrap(
      <MobileConvertWizard target="grn" onBack={() => {}} onCreated={() => {}} />,
    );

    // Step 1 → tick the PO, which unlocks the per-line received-qty step.
    await userEvent.click(await screen.findByText("HC-PO-2608-001"));

    expect(await screen.findByText(SOFA_SUMMARY)).toBeTruthy();
  });
});
