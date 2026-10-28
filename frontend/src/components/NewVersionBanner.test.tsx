import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useVersionCheck } = vi.hoisted(() => ({
  useVersionCheck: vi.fn(() => ({ updateReady: false })),
}));
vi.mock("../hooks/useVersionCheck", () => ({ useVersionCheck }));
vi.mock("../lib/errorReporter", () => ({ reportClientError: vi.fn() }));

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

/** Fresh module graph per test: lib/staleBuild's failure flag is a module-level
 *  latch, so one test tripping it would decide every later one. */
async function mount({ updateReady }: { updateReady: boolean }) {
  vi.resetModules();
  useVersionCheck.mockReturnValue({ updateReady });
  const stale = await import("../lib/staleBuild");
  const { NewVersionBanner } = await import("./NewVersionBanner");
  const dispose = stale.installChunkFailureWatch();
  render(
    <MemoryRouter>
      <NewVersionBanner />
    </MemoryRouter>,
  );
  return { dispose };
}

function dispatchPreloadError(message: string) {
  const event = new Event("vite:preloadError", { cancelable: true });
  (event as Event & { payload?: unknown }).payload = new Error(message);
  // act(): the store notifies from outside React (Vite's helper is not a React
  // event), which is exactly why the banner reads it through useSyncExternalStore.
  act(() => {
    window.dispatchEvent(event);
  });
}

const CHUNK_GONE =
  "Failed to fetch dynamically imported module: https://erp.houzscentury.com/assets3/purchase-order-pdf-AbC123.js";

describe("NewVersionBanner", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
    cleanup();
  });

  it("shows nothing when the build is current and nothing has failed", async () => {
    disposers.push((await mount({ updateReady: false })).dispose);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers the upgrade when a poll finds a newer build", async () => {
    disposers.push((await mount({ updateReady: true })).dispose);
    expect(screen.getByText(/A newer version is ready/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh now/ })).toBeTruthy();
  });

  it("appears on a FAILED dynamic import even when no poll has noticed yet", async () => {
    // The 55-site hole. An `await import()` inside an async click handler is
    // caught by that handler's own try/catch, so it reaches no error boundary
    // and no unhandledrejection listener: before this, an operator clicking
    // Print after a deploy got a raw "Failed to fetch dynamically imported
    // module: …/assets3/purchase-order-pdf-AbC123.js" toast, and clicking again
    // failed identically forever with nothing on screen offering a way out.
    disposers.push((await mount({ updateReady: false })).dispose);
    expect(screen.queryByRole("status")).toBeNull();

    dispatchPreloadError(CHUNK_GONE);

    expect(screen.getByText(/This tab is on an older version/)).toBeTruthy();
    expect(screen.getByText(/refresh to finish that action/)).toBeTruthy();
  });

  it("stays hidden when the failing module merely threw while evaluating", async () => {
    disposers.push((await mount({ updateReady: false })).dispose);
    dispatchPreloadError("Cannot read properties of undefined (reading 'jsPDF')");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("NewVersionBanner is mounted where BOTH surfaces see it", () => {
  it("is mounted from main.tsx and not from the desktop-only App", () => {
    // AuthGate renders MobileApp INSTEAD of App, so a mount inside App() reached
    // the desktop shell only and all 28 lazy mobile screens got no warning at
    // all — half the product, and the half used in the field.
    expect(src("main.tsx")).toContain("<NewVersionBanner />");
    expect(src("App.tsx")).not.toContain("<NewVersionBanner");
    expect(src("auth/AuthGate.tsx")).toContain("<MobileApp />");
  });
});

describe("the mobile tab bar cannot be covered by the banner", () => {
  /** The pill is position:fixed at z-100 and the mobile tab bar sits at z-30, so
   *  an overlap is the pill sitting ON the tabs. The three numbers that decide
   *  it live in two files; read them back rather than trusting a comment. */
  function px(source: string, pattern: RegExp): number {
    const m = source.match(pattern);
    expect(m, `no match for ${pattern}`).toBeTruthy();
    return Number(m![1]);
  }

  it("clears the tab bar's real height at the breakpoint useIsMobile uses", () => {
    const css = src("mobile/mobile.css");
    const tabBarHeight = px(css, /\.hz-m \.tabbar \{[^}]*height: (\d+)px/);
    const navWrapPadding = px(
      css,
      /\.hz-m \.navwrap \{[^}]*padding: 0 \d+px calc\(env\(safe-area-inset-bottom\) \+ (\d+)px\)/,
    );
    const bannerOffset = px(
      src("components/NewVersionBanner.tsx"),
      /bottom-\[calc\(env\(safe-area-inset-bottom\)\+(\d+)px\)\]/,
    );

    expect(bannerOffset).toBeGreaterThan(tabBarHeight + navWrapPadding);

    // `lg` must stay the breakpoint useIsMobile flips at, or the desktop offset
    // would apply on a viewport that is still rendering the mobile shell.
    // Tailwind's stock `lg` is 1024px; the config must not have redefined it.
    expect(src("components/NewVersionBanner.tsx")).toContain("lg:bottom-6");
    expect(src("mobile/useIsMobile.ts")).toContain("breakpoint = 1024");
    expect(readFileSync(join(process.cwd(), "tailwind.config.js"), "utf8")).not.toMatch(
      /\bscreens\b/,
    );
  });
});
