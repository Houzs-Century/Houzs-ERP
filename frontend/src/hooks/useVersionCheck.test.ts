import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestBuildIdFrom, useVersionCheck } from "./useVersionCheck";

// A new build is detected by the <meta name="houzs-build-id"> stamp, NOT by the
// entry-chunk filename. The filename approach compared the FIRST <script
// type=module>, which under Rolldown is rolldown-runtime-<hash>.js — a chunk
// whose hash is stable across app builds, so the prompt went silently dead for
// everyone. These pin the parse to the per-deploy stamp so that cannot recur.
describe("useVersionCheck build-id parsing", () => {
  const html = (buildId: string, entry: string) =>
    `<!doctype html><html><head>` +
    `<meta name="houzs-build-id" content="${buildId}">` +
    `<link rel="modulepreload" href="/assets3/react-vendor-CNN4Jg4e.js">` +
    `<script type="module" crossorigin src="${entry}"></script>` +
    `</head><body></body></html>`;

  it("reads the per-deploy meta stamp, regardless of assetsDir or chunk name", () => {
    // Same STABLE entry chunk (rolldown-runtime), two different builds: the old
    // filename compare saw no change here; the meta stamp does.
    expect(latestBuildIdFrom(html("mucdr5ss", "/assets3/rolldown-runtime-BHe.js"))).toBe("mucdr5ss");
    expect(latestBuildIdFrom(html("mucbr8iy", "/assets3/rolldown-runtime-BHe.js"))).toBe("mucbr8iy");
    expect(latestBuildIdFrom(html("xyz789", "/assets9/rolldown-runtime-BHe.js"))).toBe("xyz789");
  });

  it("returns null when the html carries no build stamp", () => {
    // The dev server serves an un-stamped index.html; a stampless page must
    // never read as "a new build is live".
    expect(latestBuildIdFrom(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
    expect(latestBuildIdFrom("<!doctype html><html><body>nothing</body></html>")).toBeNull();
  });

  it("does not confuse a modulepreload hash for the build id", () => {
    // A preload link changes independently of the stamp; matching one would
    // false-positive every poll (the failure mode the entry-chunk regex had).
    expect(latestBuildIdFrom(html("mucdr5ss", "/assets3/initial-app-Dkp.js"))).toBe("mucdr5ss");
  });
});

// The banner only helps if it is up BEFORE the operator clicks into a module
// this tab has never opened — that click is what fetches a chunk the deploy may
// have taken away. At the old 5-minute cadence, against ~30-70 merges a day
// and 100+ code-split routes, it usually was not: a live audit caught five
// 404-then-reload flashes in one session. These pin the two things that shrank
// the window, because both are silent when they regress.
describe("useVersionCheck detection window", () => {
  const BOOT_ID = "boot0000";
  const indexHtml = (buildId: string) =>
    `<!doctype html><html><head><meta name="houzs-build-id" content="${buildId}">` +
    `<script type="module" crossorigin src="/assets3/rolldown-runtime-BHe.js"></script>` +
    `</head><body></body></html>`;
  const fetchMock = vi.fn();
  let bootMeta: HTMLMetaElement;
  let lastUpdateReady = false;

  function Harness({ routeKey }: { routeKey: string }) {
    lastUpdateReady = useVersionCheck({ routeKey }).updateReady;
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    lastUpdateReady = false;
    // The build this tab BOOTED with — read at call time by bootBuildId().
    bootMeta = document.createElement("meta");
    bootMeta.name = "houzs-build-id";
    bootMeta.content = BOOT_ID;
    document.head.appendChild(bootMeta);
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      // Same build as boot, so updateReady stays false and the hook keeps
      // checking — this measures cadence, not detection.
      text: async () => indexHtml(BOOT_ID),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    bootMeta.remove();
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

  it("flags updateReady when only the <meta> id changed (stable entry chunk)", async () => {
    // The regression this hook exists to prevent: the deployed entry chunk is
    // byte-identical to boot (rolldown-runtime), yet a newer build IS live. The
    // meta stamp differs, so detection must fire even though the chunk did not.
    fetchMock.mockResolvedValue({ ok: true, text: async () => indexHtml("newbuild9") });
    render(createElement(Harness, { routeKey: "/scm/sales-orders" }));
    await flush();

    expect(lastUpdateReady).toBe(true);
  });
});
