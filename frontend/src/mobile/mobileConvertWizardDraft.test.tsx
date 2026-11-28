import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      state.lastStatus = body.asDraft === true ? "DRAFT" : "DISPATCHED";
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

    expect(await screen.findByText("KETTA FIRM MATTRESS")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Delivery Order/i }));

    expect(server.created).toBe(1);

    expect(server.lastStatus).toBe("DRAFT");
    expect(server.stockOutLines).toBe(0);
    expect(server.soSynced).toBe(false);
  });

  it("sends asDraft explicitly — an omitted field means DISPATCHED on this route", async () => {
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
