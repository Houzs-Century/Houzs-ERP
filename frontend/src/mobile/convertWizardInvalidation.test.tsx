import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));

import { invalidateConvertShared } from "./sharedInvalidate";
import { MobileConvertWizard } from "./MobileConvertWizard";

afterEach(cleanup);
beforeEach(() => { authedFetch.mockReset(); });

describe("invalidateConvertShared covers the mobile wizard's own reads", () => {
  it("marks every convertible-line root stale, not just the document lists", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    qc.setQueryData(["convert-source", "so"], { salesOrders: [] });
    qc.setQueryData(["convert-lines", "do", "HC-SO-2608-001"], { lines: [] });
    qc.setQueryData(["convert-grn-lines", "po-1"], { items: [] });
    qc.setQueryData(["mfg-sales-orders"], { salesOrders: [] });

    invalidateConvertShared(qc);

    const stale = (key: unknown[]) => qc.getQueryCache().find({ queryKey: key })?.isStale();
    expect(stale(["mfg-sales-orders"])).toBe(true);
    expect(stale(["convert-source", "so"])).toBe(true);
    expect(stale(["convert-lines", "do", "HC-SO-2608-001"])).toBe(true);
    expect(stale(["convert-grn-lines", "po-1"])).toBe(true);
  });

  it("a convert elsewhere makes a MOUNTED wizard re-read its lines", async () => {
    let remaining = 5;
    authedFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/mfg-sales-orders?limit=200")) {
        return { salesOrders: [{ doc_no: "HC-SO-2608-001", status: "OPEN", debtor_name: "Walk-in" }] };
      }
      if (url.startsWith("/delivery-orders-mfg/deliverable-so-lines")) {
        return {
          lines: [{
            soItemId: "sl-1", docNo: "HC-SO-2608-001", itemCode: "KETTA-FIRM MATT (K)",
            description: "KETTA FIRM MATTRESS", itemGroup: "mattress", variants: null,
            qty: 5, remaining, unitPriceSen: 0, debtorName: "Walk-in",
          }],
        };
      }
      return {};
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MobileConvertWizard
          target="do"
          initialSourceId="HC-SO-2608-001"
          onBack={() => {}}
          onCreated={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("KETTA FIRM MATTRESS")).toBeTruthy();
    const readsBefore = authedFetch.mock.calls.filter(
      (c: unknown[]) => String(c[0]).startsWith("/delivery-orders-mfg/deliverable-so-lines"),
    ).length;
    expect(readsBefore).toBe(1);

    remaining = 2;
    invalidateConvertShared(qc);

    await waitFor(() => {
      const now = authedFetch.mock.calls.filter(
        (c: unknown[]) => String(c[0]).startsWith("/delivery-orders-mfg/deliverable-so-lines"),
      ).length;
      expect(now).toBeGreaterThan(readsBefore);
    });
  });
});
