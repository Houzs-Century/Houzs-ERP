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
    expect(src("main.tsx")).toContain("<NewVersionBanner />");
    expect(src("App.tsx")).not.toContain("<NewVersionBanner");
    expect(src("auth/AuthGate.tsx")).toContain("<MobileApp />");
  });
});

describe("the mobile tab bar cannot be covered by the banner", () => {
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

    expect(src("components/NewVersionBanner.tsx")).toContain("lg:bottom-6");
    expect(src("mobile/useIsMobile.ts")).toContain("breakpoint = 1024");
    expect(readFileSync(join(process.cwd(), "tailwind.config.js"), "utf8")).not.toMatch(
      /\bscreens\b/,
    );
  });
});
