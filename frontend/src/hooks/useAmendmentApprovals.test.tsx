
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
let hubConnected = false;
vi.mock("./useItSupportConnected", () => ({ useItSupportConnected: () => hubConnected }));

const { useApprovalBadgeCounts, useMeetingsUnread, AMENDMENT_APPROVALS_KEY, MEETINGS_UNREAD_KEY } = await import("./useAmendmentApprovals");
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
  hubConnected = false;
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

  test("Meetings unread joins only where the IT Hub is connected, and the phone shares the key", async () => {
    hubConnected = true;
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/badge-counts")) return { counts: { "amendment-approvals": 0, "po-amendment-approvals": 0, "it-support-replies": 0, "meetings-unread": 120 } };
      if (path === "/api/meetings/unread-count") return { count: 1 };
      throw new Error(`unexpected ${path}`);
    });
    const { result } = renderHook(() => useApprovalBadgeCounts(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current["meetings-unread"]).toBe(120));
    expect(apiGet).toHaveBeenCalledWith(
      "/api/badge-counts?sources=amendment-approvals,po-amendment-approvals,it-support-replies,meetings-unread",
    );
    expect(client.getQueryData(MEETINGS_UNREAD_KEY)).toEqual({ count: 120 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: MEETINGS_UNREAD_KEY });
    });
    await waitFor(() => expect(result.current["meetings-unread"]).toBe(1));
  });

  test("no hub, no Meetings count and no request for it", async () => {
    apiGet.mockResolvedValue({ counts: {} });
    const { result } = renderHook(() => useMeetingsUnread(), { wrapper: wrap(client) });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(0);
    expect(apiGet).not.toHaveBeenCalled();
  });

  test("a failed Meetings read shows no badge", async () => {
    hubConnected = true;
    apiGet.mockRejectedValue(Object.assign(new Error("hub down"), { status: 502 }));
    const { result } = renderHook(() => useMeetingsUnread(), { wrapper: wrap(client) });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/meetings/unread-count"));
    expect(result.current).toBe(0);
  });
});
