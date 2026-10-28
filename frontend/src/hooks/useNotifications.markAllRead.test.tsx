/* "MARK ALL READ" EXISTED ONLY ON THE PHONE.
 *
 * MobileInbox had a working bulk mark-read; the desktop Notifications page —
 * the one the bell's "view all" lands on — had no write at all, only Reload.
 * Same feed, same endpoint, same user: on a phone you could clear it, at a desk
 * you could not.
 *
 * The fix does NOT copy MobileInbox's loop onto the desktop page. Both surfaces
 * already consume `useNotifications`, so the action belongs in the provider they
 * share — one implementation, one error contract, two callers. Copying it would
 * have been the same duplication class this whole audit is about.
 *
 * Two things are pinned here, and the second is the one with teeth:
 *
 *   1. it posts to every project carrying unread items, and to no others
 *   2. it REPORTS failures instead of eating them
 *
 * (2) is a real change, not a tidy-up. MobileInbox's version ended each request
 * with `.catch(() => {})`, so a bulk mark-read that failed for every project
 * looked identical to one that worked: the spinner stopped, the list reloaded,
 * the badge stayed up, and nothing was said. That is the "a failure that reaches
 * nobody is worse than a crash" rule, and the shared version returns counts so
 * each surface can render the truth.
 */
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
    // 12 had a zero count — posting for it is a pointless round-trip.
    expect(posted).toEqual(["/api/projects/11/read", "/api/projects/13/read"]);
  });

  test("reports how many failed instead of swallowing them", async () => {
    /* The shape that used to be invisible: the server refuses, and the screen
       says nothing at all. */
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
