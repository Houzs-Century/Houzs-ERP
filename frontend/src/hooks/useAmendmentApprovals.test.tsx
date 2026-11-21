/* The sidebar's red counts (hooks/useAmendmentApprovals.ts). Pinned: a page
   load costs ONE combined request, not one per count; each answer lands under
   that count's own key, so a writer invalidating it re-reads just that count;
   a count the server could not answer shows no badge WITHOUT a second direct
   read; the amendment counts are asked only of their approvers; a backend
   without the combined route falls back to the per-count reads. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiGet = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (path: string) => apiGet(path) } }));
const perms = new Set<string>();
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 7 }, can: (p: string) => perms.has(p) }),
}));
vi.mock("./useItSupportConnected", () => ({ useItSupportConnected: () => false }));

const { useApprovalBadgeCounts, AMENDMENT_APPROVALS_KEY, PO_AMENDMENT_APPROVALS_KEY } = await import("./useAmendmentApprovals");

/** An SO lane approver and the PO amendment approver: both amendment counts are theirs. */
function grantAmendmentApprovers() {
  perms.add("scm.amendment.approve_lines");
  perms.add("scm.po_amendment.approve");
}
const { resetVisiblePollForTests } = await import("../lib/visiblePoll");

function wrap(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  perms.clear();
  apiGet.mockReset();
});

afterEach(() => {
  client.clear();
  resetVisiblePollForTests();
});

describe("sidebar counts", () => {
  test("one combined request answers every count, under each count's own key", async () => {
    grantAmendmentApprovers();
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/badge-counts")) {
        return { counts: { "amendment-approvals": 3, "po-amendment-approvals": null } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });

    await waitFor(() => expect(result.current["amendment-approvals"]).toBe(3));
    // The one the server could not answer (its gate refused) shows no badge and
    // is NOT re-asked directly: that second read collected the same 403 on every
    // page load (production, 7 days: 919 for the PO count).
    await waitFor(() => expect(client.getQueryData(PO_AMENDMENT_APPROVALS_KEY)).toEqual({ count: 0 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual([
      "/api/badge-counts?sources=amendment-approvals,po-amendment-approvals",
    ]);
    expect(result.current["po-amendment-approvals"]).toBe(0);
    expect(client.getQueryData(AMENDMENT_APPROVALS_KEY)).toEqual({ count: 3 });
  });

  test("a writer invalidating one count re-reads that count alone", async () => {
    grantAmendmentApprovers();
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/badge-counts")) {
        return { counts: { "amendment-approvals": 3, "po-amendment-approvals": 0 } };
      }
      if (path === "/api/scm/so-amendments/pending-count") return { count: 2 };
      throw new Error(`unexpected ${path}`);
    });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current["amendment-approvals"]).toBe(3));

    await act(async () => {
      await client.invalidateQueries({ queryKey: AMENDMENT_APPROVALS_KEY });
    });
    await waitFor(() => expect(result.current["amendment-approvals"]).toBe(2));
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual([
      "/api/badge-counts?sources=amendment-approvals,po-amendment-approvals",
      "/api/scm/so-amendments/pending-count",
    ]);
  });

  test("permission-gated counts join the combined request only for their holders", async () => {
    perms.add("scm.payment_voucher.create");
    apiGet.mockResolvedValue({ counts: { "payment-requests-waiting": 4, "finance-todo": 1 } });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current["payment-requests-waiting"]).toBe(4));
    expect(result.current["finance-todo"]).toBe(1);
    expect(apiGet).toHaveBeenCalledWith("/api/badge-counts?sources=payment-requests-waiting,finance-todo");
  });

  test("the amendment counts are asked only of someone who can approve one", async () => {
    perms.add("scm.so_cancel.approve_l1");
    apiGet.mockResolvedValue({ counts: { "amendment-approvals": 2 } });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current["amendment-approvals"]).toBe(2));
    // A cancellation approver signs in the SO queue; nobody here approves POs,
    // so the PO count (an area-guarded endpoint that would 403) is never asked.
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual(["/api/badge-counts?sources=amendment-approvals"]);
    expect(result.current["po-amendment-approvals"]).toBe(0);
  });

  test("without the combined route, each count falls back to its own read", async () => {
    grantAmendmentApprovers();
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/badge-counts")) throw Object.assign(new Error("Not Found"), { status: 404 });
      if (path === "/api/scm/so-amendments/pending-count") return { count: 5 };
      if (path === "/api/scm/po-amendments/pending-count") return { count: 1 };
      throw new Error(`unexpected ${path}`);
    });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current["amendment-approvals"]).toBe(5));
    expect(result.current["po-amendment-approvals"]).toBe(1);
  });
});
