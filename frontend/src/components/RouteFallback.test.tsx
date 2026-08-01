import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_BUILD_ID, ChunkReloadBoundary, hardRecover } from "./RouteFallback";

const { reportClientError } = vi.hoisted(() => ({
  reportClientError: vi.fn(),
}));

vi.mock("../lib/errorReporter", () => ({ reportClientError }));

const RECOVER_AT_KEY = "chunk-recovered-at";

function ThrowError({ message }: { message: string }): never {
  throw new Error(message);
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("ChunkReloadBoundary", () => {
  let serviceWorkerDescriptor: PropertyDescriptor | undefined;
  let cachesDescriptor: PropertyDescriptor | undefined;
  const getRegistrations = vi.fn();
  const cacheKeys = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    sessionStorage.clear();
    reportClientError.mockReset();
    getRegistrations.mockReset().mockImplementation(() => never());
    cacheKeys.mockReset().mockResolvedValue([]);
    serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    cachesDescriptor = Object.getOwnPropertyDescriptor(window, "caches");
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations },
    });
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: cacheKeys, delete: vi.fn() },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
    if (serviceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
    if (cachesDescriptor) {
      Object.defineProperty(window, "caches", cachesDescriptor);
    } else {
      Reflect.deleteProperty(window, "caches");
    }
    vi.useRealTimers();
  });

  it("starts one hard recovery for a stale chunk and times out to the panel", async () => {
    render(
      <ChunkReloadBoundary resetKey="/orders">
        <ThrowError message="Failed to fetch dynamically imported module" />
      </ChunkReloadBoundary>,
    );

    expect(screen.getByLabelText("Loading page")).toBeTruthy();
    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(RECOVER_AT_KEY) ?? "{}")).toEqual({
      at: Date.now(),
      buildId: CURRENT_BUILD_ID,
    });
    expect(reportClientError).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();
    expect(getRegistrations).toHaveBeenCalledTimes(1);
  });

  it("completes service-worker and cache cleanup before reloading", async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    getRegistrations.mockResolvedValue([{ unregister }]);
    cacheKeys.mockResolvedValue(["old-shell", "old-assets"]);
    const cacheDelete = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: { keys: cacheKeys, delete: cacheDelete },
    });
    const reload = vi.fn();

    await hardRecover(reload);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledTimes(2);
    expect(cacheDelete).toHaveBeenCalledWith("old-shell");
    expect(cacheDelete).toHaveBeenCalledWith("old-assets");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload.mock.invocationCallOrder[0]).toBeGreaterThan(cacheDelete.mock.invocationCallOrder[1]);
    // Regression: the 8s cleanup DEADLINE must not outlive the race it bounded.
    // A pending timer here is a timer that fires after its environment is gone
    // — which is how a CI run reported "window is not defined" from an
    // unrelated test file, failed `npm test`, and SKIPPED a frontend deploy.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spends the cooldown per build — a failure on a newly landed build recovers again", async () => {
    // The attempt on record ran on an OLDER build, so it worked: the reload
    // landed this one. A chunk failing here is a new fault (owner 2026-07-31:
    // two deploys inside the 60s window left him on the panel), so it gets its
    // own recovery instead of inheriting the spent cooldown.
    sessionStorage.setItem(
      RECOVER_AT_KEY,
      JSON.stringify({ at: Date.now() - 1_000, buildId: "older-build" }),
    );

    render(
      <ChunkReloadBoundary resetKey="/scm/purchase-orders">
        <ThrowError message="Failed to fetch dynamically imported module" />
      </ChunkReloadBoundary>,
    );

    expect(screen.getByLabelText("Loading page")).toBeTruthy();
    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(reportClientError).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(RECOVER_AT_KEY) ?? "{}")).toEqual({
      at: Date.now(),
      buildId: CURRENT_BUILD_ID,
    });
  });

  it("keeps the cooldown when the recorded attempt is from the same build", () => {
    sessionStorage.setItem(
      RECOVER_AT_KEY,
      JSON.stringify({ at: Date.now() - 1_000, buildId: CURRENT_BUILD_ID }),
    );

    render(
      <ChunkReloadBoundary resetKey="/orders">
        <ThrowError message="Loading chunk 42 failed" />
      </ChunkReloadBoundary>,
    );

    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Loading chunk 42 failed" }),
      "stale-chunk-persisted",
    );
  });

  it("honours a legacy bare-timestamp mark as a same-build attempt", () => {
    sessionStorage.setItem(RECOVER_AT_KEY, String(Date.now() - 1_000));

    render(
      <ChunkReloadBoundary resetKey="/orders">
        <ThrowError message="Loading chunk 42 failed" />
      </ChunkReloadBoundary>,
    );

    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Loading chunk 42 failed" }),
      "stale-chunk-persisted",
    );
  });

  it("does not auto-reload when sessionStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    render(
      <ChunkReloadBoundary resetKey="/orders">
        <ThrowError message="Importing a module script failed" />
      </ChunkReloadBoundary>,
    );

    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Importing a module script failed" }),
      "stale-chunk-persisted",
    );
  });

  it("reports a non-chunk render error and shows the fallback panel", () => {
    render(
      <ChunkReloadBoundary resetKey="/inventory">
        <ThrowError message="Cannot read properties of undefined" />
      </ChunkReloadBoundary>,
    );

    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Cannot read properties of undefined" }),
      "route-crash",
    );
  });

  it("clears a route error when the reset key changes", () => {
    const view = render(
      <ChunkReloadBoundary resetKey="/broken">
        <ThrowError message="ordinary render failure" />
      </ChunkReloadBoundary>,
    );
    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();

    view.rerender(
      <ChunkReloadBoundary resetKey="/healthy">
        <div>Healthy route</div>
      </ChunkReloadBoundary>,
    );

    expect(screen.getByText("Healthy route")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this page.")).toBeNull();
  });
});
