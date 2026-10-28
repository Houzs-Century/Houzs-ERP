/* THE PHONE WIZARD'S OWN READS WERE IN NOBODY'S INVALIDATION SET.
 *
 * `MobileConvertWizard` reads its source list and its convertible lines under
 * three PRIVATE query-key roots that it invented and nothing else knows about:
 *
 *     ["convert-source",    <sourceKind>]
 *     ["convert-lines",     <target>, <sourceId>]
 *     ["convert-grn-lines", <poIds>]
 *
 * `sharedInvalidate.ts` opens by naming this exact hazard class — "several
 * mobile screens still mutate via raw authedFetch + private ["mobile-*"] query
 * keys, so a DESKTOP tab reads a stale … convert … after a mobile save" — and
 * then does not cover the wizard's own keys. So the failure runs the other way
 * too: a convert completed ANYWHERE (the desktop pickers, another mobile flow,
 * or this very wizard a moment earlier) leaves a mounted phone wizard still
 * offering lines that have already been consumed. The operator picks them, taps
 * Create, and the server refuses with `over_remaining` — or, worse, the
 * remaining pool has only partly shrunk and a wrong quantity goes through.
 *
 * The fix is one line of routing, not a fourth private key: the wizard's roots
 * join `invalidateConvertShared`, which every convert already calls. These are
 * its assertions.
 *
 * The second `it` is the one that would have caught the real report, because it
 * drives the mechanism end to end: a convert that happens while the wizard is
 * MOUNTED must make it re-read its lines.
 */
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

    /* Seed one entry under each root the wizard actually uses, exactly as it
       keys them. `setQueryData` leaves them FRESH; invalidation is what turns
       them stale, so `isStale()` is the honest read of whether they were
       covered. */
    qc.setQueryData(["convert-source", "so"], { salesOrders: [] });
    qc.setQueryData(["convert-lines", "do", "HC-SO-2608-001"], { lines: [] });
    qc.setQueryData(["convert-grn-lines", "po-1"], { items: [] });
    // A control from the set that was ALREADY covered — if this one goes stale
    // and the three above do not, the helper ran and simply skipped them.
    qc.setQueryData(["mfg-sales-orders"], { salesOrders: [] });

    invalidateConvertShared(qc);

    const stale = (key: unknown[]) => qc.getQueryCache().find({ queryKey: key })?.isStale();
    expect(stale(["mfg-sales-orders"])).toBe(true);
    expect(stale(["convert-source", "so"])).toBe(true);
    expect(stale(["convert-lines", "do", "HC-SO-2608-001"])).toBe(true);
    expect(stale(["convert-grn-lines", "po-1"])).toBe(true);
  });

  it("a convert elsewhere makes a MOUNTED wizard re-read its lines", async () => {
    /* The reported failure, driven end to end. The line pool shrinks between the
       first read and the second; a wizard left on a stale read would keep
       offering the consumed line. */
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

    // Somebody else converts the same Sales Order.
    remaining = 2;
    invalidateConvertShared(qc);

    // THE ASSERTION: the mounted wizard goes back to the server for the pool.
    await waitFor(() => {
      const now = authedFetch.mock.calls.filter(
        (c: unknown[]) => String(c[0]).startsWith("/delivery-orders-mfg/deliverable-so-lines"),
      ).length;
      expect(now).toBeGreaterThan(readsBefore);
    });
  });
});
