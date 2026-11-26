import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestBuildIdFrom, useVersionCheck } from "./useVersionCheck";

describe("useVersionCheck build-id parsing", () => {
  const html = (buildId: string, entry: string) =>
    `<!doctype html><html><head>` +
    `<meta name="houzs-build-id" content="${buildId}">` +
    `<link rel="modulepreload" href="/assets3/react-vendor-CNN4Jg4e.js">` +
    `<script type="module" crossorigin src="${entry}"></script>` +
    `</head><body></body></html>`;

  it("reads the per-deploy meta stamp, regardless of assetsDir or chunk name", () => {
    expect(latestBuildIdFrom(html("mucdr5ss", "/assets3/rolldown-runtime-BHe.js"))).toBe("mucdr5ss");
    expect(latestBuildIdFrom(html("mucbr8iy", "/assets3/rolldown-runtime-BHe.js"))).toBe("mucbr8iy");
    expect(latestBuildIdFrom(html("xyz789", "/assets9/rolldown-runtime-BHe.js"))).toBe("xyz789");
  });

  it("returns null when the html carries no build stamp", () => {
    expect(latestBuildIdFrom(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
    expect(latestBuildIdFrom("<!doctype html><html><body>nothing</body></html>")).toBeNull();
  });

  it("does not confuse a modulepreload hash for the build id", () => {
    expect(latestBuildIdFrom(html("mucdr5ss", "/assets3/initial-app-Dkp.js"))).toBe("mucdr5ss");
  });
});

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
    bootMeta = document.createElement("meta");
    bootMeta.name = "houzs-build-id";
    bootMeta.content = BOOT_ID;
    document.head.appendChild(bootMeta);
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
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

    view.rerender(createElement(Harness, { routeKey: "/scm/purchase-invoices" }));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not restart the poll clock on every navigation", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("flags updateReady when only the <meta> id changed (stable entry chunk)", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => indexHtml("newbuild9") });
    render(createElement(Harness, { routeKey: "/scm/sales-orders" }));
    await flush();

    expect(lastUpdateReady).toBe(true);
  });
});
