/* The daily reminder asks the SAME endpoint as the My Pending list.
 *
 * That is the property with teeth, and it is asserted here: the popup must not
 * be able to say "26 events" while the screen it sends you to shows something
 * else. Re-deriving "what is mine" would mean a fourteenth copy of the thirteen
 * role lanes in services/projects.ts — the code that routes every staff
 * member's day — so the hook issues `my_pending=1` and counts what comes back.
 *
 * Also pinned: acknowledging is remembered PER DAY, so the reminder returns
 * tomorrow on its own with no cron to run and nothing to reset.
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: apiGet } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: { id: 7 } }) }));
vi.mock("../lib/storageIdentity", () => ({
  identityStorageKey: (base: string) => `${base}:u7:c1`,
  subscribeBrowserStorageIdentity: () => () => {},
}));

import { usePendingReminder } from "./usePendingReminder";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const row = (id: number, start: string, end: string) => ({
  id,
  name: `E${id}`,
  start_date: start,
  end_date: end,
});

beforeEach(() => {
  apiGet.mockReset();
  localStorage.clear();
  apiGet.mockResolvedValue({ data: [], total: 0 });
});

describe("usePendingReminder", () => {
  it("asks the My Pending list endpoint, not one of its own", async () => {
    renderHook(() => usePendingReminder(), { wrapper });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = String(apiGet.mock.calls[0][0]);
    expect(url).toContain("/api/projects");
    expect(url).toContain("my_pending=1");
  });

  it("stays shut when nothing is owed", async () => {
    const { result } = renderHook(() => usePendingReminder(), { wrapper });
    await waitFor(() => expect(result.current.digest).not.toBeNull());
    expect(result.current.open).toBe(false);
  });

  it("opens when work is owed, and groups it worst-first", async () => {
    apiGet.mockResolvedValue({
      data: [row(1, "2026-12-01", "2026-12-03"), row(2, "2020-01-01", "2020-01-02")],
      total: 2,
    });
    const { result } = renderHook(() => usePendingReminder(), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.digest?.total).toBe(2);
    expect(result.current.digest?.groups[0].tier).toBe("past_event");
  });

  it("'Got it' closes it AND is remembered under today's key", async () => {
    apiGet.mockResolvedValue({ data: [row(1, "2020-01-01", "2020-01-02")], total: 1 });
    const { result } = renderHook(() => usePendingReminder(), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.acknowledge());
    expect(result.current.open).toBe(false);

    const keys = Object.keys(localStorage);
    expect(keys.some((k) => /^pending-reminder:u7:c1:\d{4}-\d{2}-\d{2}$/.test(k))).toBe(true);
  });

  it("a stored acknowledgement from TODAY keeps it shut on the next load", async () => {
    apiGet.mockResolvedValue({ data: [row(1, "2020-01-01", "2020-01-02")], total: 1 });
    const today = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    localStorage.setItem(
      `pending-reminder:u7:c1:${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
      "1",
    );
    const { result } = renderHook(() => usePendingReminder(), { wrapper });
    expect(result.current.open).toBe(false);
    // ...and it does not even ask, so an acknowledged day costs no request.
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("YESTERDAY's acknowledgement does not silence today", async () => {
    apiGet.mockResolvedValue({ data: [row(1, "2020-01-01", "2020-01-02")], total: 1 });
    localStorage.setItem("pending-reminder:u7:c1:2020-01-01", "1");
    const { result } = renderHook(() => usePendingReminder(), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(true));
  });

  it("'Remind later' hides it for this tab without writing an acknowledgement", async () => {
    apiGet.mockResolvedValue({ data: [row(1, "2026-12-01", "2026-12-03")], total: 1 });
    const { result } = renderHook(() => usePendingReminder(), { wrapper });
    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.postpone());
    expect(result.current.open).toBe(false);
    expect(Object.keys(localStorage).some((k) => k.startsWith("pending-reminder:"))).toBe(false);
  });
});
