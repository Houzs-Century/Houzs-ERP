import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 7 } }) }));

import { NotificationsProvider, useNotifications } from "./useNotifications";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NotificationsProvider>{children}</NotificationsProvider>
);

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue({
    feed: [],
    unread_by_project: { 11: 3, 12: 0, 13: 1 },
    total_unread: 4,
  });
  apiPost.mockResolvedValue({});
});

describe("useNotifications().markAllRead", () => {
  test("posts once per project that actually has unread items", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.totalUnread).toBe(4));

    await act(async () => { await result.current.markAllRead(); });

    const posted = apiPost.mock.calls.map(([url]) => url).sort();
    expect(posted).toEqual(["/api/projects/11/read", "/api/projects/13/read"]);
  });

  test("reports how many failed instead of swallowing them", async () => {
    apiPost.mockRejectedValue(new Error("403 forbidden"));
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.totalUnread).toBe(4));

    let outcome!: { ok: number; failed: number };
    await act(async () => { outcome = await result.current.markAllRead(); });

    expect(outcome).toEqual({ ok: 0, failed: 2 });
  });

  test("a clean run reports every project as marked", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.totalUnread).toBe(4));

    let outcome!: { ok: number; failed: number };
    await act(async () => { outcome = await result.current.markAllRead(); });

    expect(outcome).toEqual({ ok: 2, failed: 0 });
  });

  test("nothing unread posts nothing", async () => {
    apiGet.mockResolvedValue({ feed: [], unread_by_project: {}, total_unread: 0 });
    const { result } = renderHook(() => useNotifications(), { wrapper });

    let outcome!: { ok: number; failed: number };
    await act(async () => { outcome = await result.current.markAllRead(); });

    expect(apiPost).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: 0, failed: 0 });
  });
});
