import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RefreshButton } from "./RefreshButton";
import { clearAll } from "../api/cache";

/* ────────────────────────────────────────────────────────────────────────────
   Global refresh button (components/RefreshButton.tsx).

   What these pin is the ORDER, because that is the whole difference between a
   refresh and a decoration. api/cache.ts is a 15-second memory cache in front
   of api.get(); if TanStack is invalidated FIRST, every refetch it triggers is
   answered out of that cache and the user gets the same rows back — a button
   that spins, reports success, and changes nothing for 15 seconds. Nothing
   else in the suite would catch that: the click handler runs, no error is
   thrown, and both functions were called.
   ──────────────────────────────────────────────────────────────────────────── */

vi.mock("../api/cache", () => ({ clearAll: vi.fn() }));

const mockClearAll = clearAll as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Render with a throwaway client, recording the sequence of cache drops. */
function setup(invalidateImpl?: () => Promise<void>) {
  const calls: string[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  mockClearAll.mockImplementation(() => {
    calls.push("clearApiCache");
  });
  const invalidateSpy = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockImplementation(async () => {
      calls.push("invalidateQueries");
      if (invalidateImpl) await invalidateImpl();
    });

  render(
    <QueryClientProvider client={queryClient}>
      <RefreshButton />
    </QueryClientProvider>,
  );

  return { calls, invalidateSpy, button: screen.getByRole("button", { name: /refresh data/i }) };
}

describe("RefreshButton", () => {
  it("drops the api.get cache BEFORE invalidating queries", async () => {
    const { calls, button } = setup();

    fireEvent.click(button);

    await waitFor(() => expect(calls).toEqual(["clearApiCache", "invalidateQueries"]));
  });

  it("refetches what is on screen and marks the rest stale", async () => {
    const { invalidateSpy, button } = setup();

    fireEvent.click(button);

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));
    // refetchType "active" is what makes a background page fresh on its NEXT
    // mount instead of serving a pre-refresh cache entry.
    expect(invalidateSpy).toHaveBeenCalledWith({ refetchType: "active" });
  });

  it("ignores a second click while a refresh is still running", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, button } = setup(() => inFlight);

    fireEvent.click(button);
    await waitFor(() => expect(calls).toContain("invalidateQueries"));
    fireEvent.click(button);
    fireEvent.click(button);

    // Still exactly one round trip — a double-tap must not stack refetches of
    // every active query on the page.
    expect(calls).toEqual(["clearApiCache", "invalidateQueries"]);

    // Plain DOM property, not toBeDisabled(): this repo has no
    // @testing-library/jest-dom, so that matcher is undefined and waitFor
    // swallows the "not a function" throw until it times out.
    release();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });
});
