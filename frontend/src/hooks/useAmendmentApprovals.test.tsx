/* The sidebar's red counts (hooks/useAmendmentApprovals.ts). Pinned: a page
   load costs ONE combined request, not one per count; each answer lands under
   that count's own key, so a writer invalidating it re-reads just that count;
   a count the server could not answer shows no badge; a backend without the
   combined route falls back to the per-count reads. */

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

const { useApprovalBadgeCounts, AMENDMENT_APPROVALS_KEY } = await import("./useAmendmentApprovals");
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
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/badge-counts")) {
        return { counts: { "amendment-approvals": 3, "po-amendment-approvals": null } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });

    await waitFor(() => expect(result.current["amendment-approvals"]).toBe(3));
    // Nobody here holds the other gates, so only the two open counts are asked
    // for. The one the server could not answer gets one direct try of its own
    // (it fails here too) and shows no badge; the answered one costs nothing more.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual([
      "/api/badge-counts?sources=amendment-approvals,po-amendment-approvals",
      "/api/scm/po-amendments/pending-count",
    ]);
    expect(result.current["po-amendment-approvals"]).toBe(0);
    expect(client.getQueryData(AMENDMENT_APPROVALS_KEY)).toEqual({ count: 3 });
  });

  test("a writer invalidating one count re-reads that count alone", async () => {
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
    expect(apiGet).toHaveBeenCalledWith(
      "/api/badge-counts?sources=amendment-approvals,po-amendment-approvals,payment-requests-waiting,finance-todo",
    );
  });

  test("without the combined route, each count falls back to its own read", async () => {
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
