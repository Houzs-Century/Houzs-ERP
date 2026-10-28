/* SO → DO ON THE PHONE MUST NOT SHIP THE GOODS.
 *
 * `POST /delivery-orders-mfg/from-sos` is born DISPATCHED unless the caller
 * opts out: `status: (body.asDraft === true) ? 'DRAFT' : 'DISPATCHED'`
 * (delivery-orders-mfg.ts, createDoFromSoLinesHandler), and the same flag gates
 * the write half — `if (body.asDraft !== true) { deductInventoryForDo(...);
 * syncSoDeliveredFromDo(...); maybeSendDeliveryOrderEmail(...) }`. OMITTING the
 * field is therefore not "leave it to the server", it is "ship it now": stock
 * OUT, the SO advanced to delivered, and the customer emailed — from a phone,
 * with no review step and no undo.
 *
 * The wizard's GRN arm already reasoned this through and sends `asDraft: true`,
 * with a comment about not auto-posting stock. The DO arm simply missed it.
 * This is the DO arm's assertion.
 *
 * The fake server is that ternary in miniature, and it counts the thing that
 * actually hurts — stock movements — rather than the flag, because the flag is
 * only interesting for what it makes the server do.
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

/** The create half of `from-sos`, reduced to the one decision under test. */
function fakeDoServer() {
  const state = { created: 0, lastStatus: "", stockOutLines: 0, soSynced: false };

  authedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/mfg-sales-orders?limit=200")) {
      return { salesOrders: [{ doc_no: "HC-SO-2608-001", status: "OPEN", debtor_name: "Walk-in" }] };
    }
    if (url.startsWith("/delivery-orders-mfg/deliverable-so-lines")) {
      return {
        lines: [
          {
            soItemId: "sl-1", docNo: "HC-SO-2608-001", itemCode: "KETTA-FIRM MATT (K)",
            description: "KETTA FIRM MATTRESS", itemGroup: "mattress", variants: null,
            qty: 1, remaining: 1, unitPriceSen: 0, debtorName: "Walk-in",
          },
          {
            soItemId: "sl-2", docNo: "HC-SO-2608-001", itemCode: "NTYR PILLOW",
            description: "NTYR MEMORY CONTOUR PILLOW", itemGroup: "accessories", variants: null,
            qty: 2, remaining: 2, unitPriceSen: 0, debtorName: "Walk-in",
          },
        ],
      };
    }
    if (url.startsWith("/delivery-orders-mfg/from-sos")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        asDraft?: boolean;
        picks?: Array<{ soItemId: string; qty: number }>;
      };
      state.created += 1;
      // The route's own ternary.
      state.lastStatus = body.asDraft === true ? "DRAFT" : "DISPATCHED";
      // ...and the write half it gates.
      if (body.asDraft !== true) {
        state.stockOutLines += (body.picks ?? []).length;
        state.soSynced = true;
      }
      return { id: "do-1", doNumber: "HC-DO-2608-001" };
    }
    return {};
  });

  return state;
}

describe("MobileConvertWizard — SO → DO lands a DRAFT, not a shipment", () => {
  it("does not move stock when a phone converts a Sales Order", async () => {
    const server = fakeDoServer();

    wrap(
      <MobileConvertWizard
        target="do"
        initialSourceId="HC-SO-2608-001"
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    // Lines arrive checked, with qty = remaining.
    expect(await screen.findByText("KETTA FIRM MATTRESS")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Delivery Order/i }));

    // The DO is created either way — that is not the defect.
    expect(server.created).toBe(1);

    // THE ASSERTION. A phone convert parks the document for review; it does not
    // empty the shelf, and it does not tell the Sales Order it was delivered.
    expect(server.lastStatus).toBe("DRAFT");
    expect(server.stockOutLines).toBe(0);
    expect(server.soSynced).toBe(false);
  });

  it("sends asDraft explicitly — an omitted field means DISPATCHED on this route", async () => {
    /* Guards the mechanism as well as the outcome: a future refactor that drops
       the field back out of the body would restore the auto-ship silently,
       because the server reads absence as "ship it". */
    fakeDoServer();

    wrap(
      <MobileConvertWizard
        target="do"
        initialSourceId="HC-SO-2608-001"
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    expect(await screen.findByText("KETTA FIRM MATTRESS")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Delivery Order/i }));

    const post = authedFetch.mock.calls.find(
      (c: unknown[]) => String(c[0]).startsWith("/delivery-orders-mfg/from-sos"),
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(String((post![1] as RequestInit).body)) as { asDraft?: boolean };
    expect(body.asDraft).toBe(true);
  });
});
