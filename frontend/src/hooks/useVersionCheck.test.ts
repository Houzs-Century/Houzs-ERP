import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetHashFrom, latestBuildIdFrom, useVersionCheck } from "./useVersionCheck";

// The 2026-07-31 edge-poison outage moved build.assetsDir "assets" -> "assets2"
// -> "assets3" inside an hour. This hook had "/assets/" hard-coded, so it
// stopped detecting new builds the moment the namespace moved — silently, on
// the exact deploy where a "reload for the new version" prompt mattered most.
// These pin the parse to the SHAPE of a hashed entry module, never to a name.
describe("useVersionCheck entry-chunk parsing", () => {
  const html = (src: string) =>
    `<!doctype html><html><head>` +
    `<link rel="modulepreload" href="/assets3/react-vendor-CNN4Jg4e.js">` +
    `<script type="module" crossorigin src="${src}"></script>` +
    `</head><body></body></html>`;

  it("reads the entry hash from any assetsDir name", () => {
    for (const dir of ["assets", "assets2", "assets3", "static"]) {
      expect(assetHashFrom(`https://erp.houzscentury.com/${dir}/index-AbC123.js`)).toBe(
        "index-AbC123.js",
      );
      expect(latestBuildIdFrom(html(`/${dir}/index-AbC123.js`))).toBe("index-AbC123.js");
    }
  });

  it("does not mistake the host for the asset directory", () => {
    expect(assetHashFrom("https://erp.houzscentury.com/assets3/index-AbC123.js")).toBe(
      "index-AbC123.js",
    );
    expect(assetHashFrom("http://localhost:5173/assets3/index-AbC123.js")).toBe(
      "index-AbC123.js",
    );
  });

  it("skips the check in dev instead of guessing wrong", () => {
    // The dev server serves the un-hashed source entry and nested prebundles;
    // neither is a build id, and returning null makes the hook a no-op.
    expect(assetHashFrom("http://localhost:5173/src/main.tsx")).toBeNull();
    expect(assetHashFrom("http://localhost:5173/node_modules/.vite/deps/react.js")).toBeNull();
    expect(latestBuildIdFrom(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
  });

  it("takes the entry script, not a modulepreload link", () => {
    // A preload hash differs from the entry's, so matching one would report a
    // new build on every single poll.
    expect(latestBuildIdFrom(html("/assets3/index-AbC123.js"))).toBe("index-AbC123.js");
  });

  it("returns null when the html has no module entry at all", () => {
    expect(latestBuildIdFrom("<!doctype html><html><body>nothing</body></html>")).toBeNull();
  });
});

// The banner only helps if it is up BEFORE the operator clicks into a module
// this tab has never opened — that click is what fetches a chunk the deploy may
// have taken away. At the old 5-minute cadence, against ~30-70 merges a day
// and 100+ code-split routes, it usually was not: a live audit caught five
// 404-then-reload flashes in one session. These pin the two things that shrank
// the window, because both are silent when they regress.
describe("useVersionCheck detection window", () => {
  const BOOT_ENTRY = "/assets3/index-AbC123.js";
  const indexHtml = (entry: string) =>
    `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body></body></html>`;
  const fetchMock = vi.fn();
  let bootScript: HTMLScriptElement;

  function Harness({ routeKey }: { routeKey: string }) {
    useVersionCheck({ routeKey });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    bootScript = document.createElement("script");
    bootScript.type = "module";
    bootScript.src = BOOT_ENTRY;
    document.head.appendChild(bootScript);
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      // Same entry as the boot script, so updateReady stays false and the hook
      // keeps checking — this measures cadence, not detection.
      text: async () => indexHtml(BOOT_ENTRY),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    bootScript.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  };

  it("checks once on mount, not twice", async () => {
    // The polling effect already fires one check on mount; the navigation
    // effect must not fire a second identical request behind it.
    render(createElement(Harness, { routeKey: "/scm/sales-orders" }));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls once a minute, not once every five", async () => {
    render(createElement(Harness, { routeKey: "/scm/sales-orders" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("checks on navigation, without waiting for the next tick of the poll", async () => {
    const view = render(createElement(Harness, { routeKey: "/scm/sales-orders" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No timer advance: this is the click into a module the tab has not opened.
    view.rerender(createElement(Harness, { routeKey: "/scm/purchase-invoices" }));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not restart the poll clock on every navigation", async () => {
    // Taking routeKey as a dependency of the polling effect would rebuild the
    // interval on each click, so an operator who navigates every 59 seconds
    // would never reach a periodic check at all.
    const view = render(createElement(Harness, { routeKey: "/a" }));
    await flush();

    for (const path of ["/b", "/c", "/d"]) {
      await act(async () => {
        vi.advanceTimersByTime(20_000);
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      view.rerender(createElement(Harness, { routeKey: path }));
      await flush();
    }

    // 1 mount + 3 navigations + the 60s interval tick that survived them.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
