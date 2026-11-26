import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RefreshButton } from "./RefreshButton";
import { clearAll } from "../api/cache";


vi.mock("../api/cache", () => ({ clearAll: vi.fn() }));

const mockClearAll = clearAll as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

    expect(calls).toEqual(["clearApiCache", "invalidateQueries"]);

    release();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });
});
