import { expect, test, type Page } from "@playwright/test";
import { expectBounded } from "./geometry.helpers";

/* The Delivery Planning board at 3,000 rows: how long it takes to open, how
   smoothly it scrolls, how long a search and a sort take, and what the 30 s
   poll costs. Prints one JSON line per run (PERF {...}); the bounds asserted
   are the windowing contract, not timings, so a slow machine cannot fail it. */

async function frames(page: Page, n: number) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }, n);
}

/** Wall time of `act` until the next painted frame after React committed. */
async function timeUpdate(page: Page, act: string): Promise<number> {
  return page.evaluate(async (code) => {
    const t0 = performance.now();
    (0, eval)(code);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return performance.now() - t0;
  }, act);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (n: number) => Math.round(n * 10) / 10;

async function measure(page: Page, url: string) {
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__long.push(e.duration); })
      .observe({ type: "longtask", buffered: true });
  });
  await page.goto(url);
  const rows = page.locator("tr[data-vrow]");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await frames(page, 2);
  const open = await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    const long = w.__long.splice(0);
    return {
      openMs: performance.now(),
      openLongestTaskMs: Math.max(0, ...long),
      openBlockingMs: long.reduce((s, d) => s + Math.max(0, d - 50), 0),
      domNodes: document.getElementsByTagName("*").length,
      rowsInDom: document.querySelectorAll("tr[data-vrow]").length,
      columns: document.querySelector("tr[data-vrow]")?.querySelectorAll("td").length ?? 0,
    };
  });

  // Scroll: 180 frames, 90 px per frame, through the grid's own scroller.
  const scroll = await page.evaluate(async () => {
    const w = window as unknown as { __long: number[] };
    w.__long.splice(0);
    const table = document.querySelector('[data-scenario="dp-board"] table')!;
    let el: HTMLElement | null = table.parentElement;
    while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
    const scroller = el ?? document.scrollingElement as HTMLElement;
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 180; i++) {
      scroller.scrollTop += 90;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const total = deltas.reduce((s, d) => s + d, 0);
    const long = w.__long.splice(0);
    return {
      scrollFps: (deltas.length / total) * 1000,
      scrollP95FrameMs: sorted[Math.floor(sorted.length * 0.95)]!,
      scrollWorstFrameMs: sorted[sorted.length - 1]!,
      scrollLongTasks: long.length,
      scrolledTo: scroller.scrollTop,
    };
  });
  await expectBounded(rows, 120);

  // Poll ticks.
  const same: number[] = []; const one: number[] = []; const clone: number[] = [];
  for (let i = 0; i < 5; i++) {
    same.push(await timeUpdate(page, "window.__lab.refetchSame()"));
    one.push(await timeUpdate(page, "window.__lab.refreshOne()"));
    clone.push(await timeUpdate(page, "window.__lab.refetchClone()"));
  }

  // Search: type a doc number fragment; time from the input to the settled rows.
  const search = page.getByPlaceholder(/Search SO/);
  await page.evaluate(() => window.scrollTo(0, 0));
  const searchMs = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search SO"]')!;
    const before = document.querySelectorAll("tr[data-vrow]").length;
    const t0 = performance.now();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "HC-SO-2603-01");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 600; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const n = document.querySelectorAll("tr[data-vrow]").length;
      if (n !== before && n > 0) return performance.now() - t0;
    }
    return -1;
  });
  await expect(search).toHaveValue("HC-SO-2603-01");
  const searchRows = await rows.count();
  // Clear the search again (back to every row).
  const clearMs = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search SO"]')!;
    const before = document.querySelectorAll("tr[data-vrow]").length;
    const t0 = performance.now();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 600; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (document.querySelectorAll("tr[data-vrow]").length !== before) return performance.now() - t0;
    }
    return -1;
  });

  return {
    ...Object.fromEntries(Object.entries(open).map(([k, v]) => [k, round(v)])),
    ...Object.fromEntries(Object.entries(scroll).map(([k, v]) => [k, round(v)])),
    pollNothingChangedMs: round(median(same)),
    pollOneRowChangedMs: round(median(one)),
    rereadAllNewObjectsMs: round(median(clone)),
    searchMs: round(searchMs),
    searchRows,
    clearSearchMs: round(clearMs),
  };
}

const ROWS = Number(process.env.DP_ROWS ?? 3000);
const LIMIT = process.env.DP_LIMIT ? `&limit=${process.env.DP_LIMIT}` : "";

test("Delivery Planning board at production size stays windowed and reports its timings", async ({ page }) => {
  test.setTimeout(180_000);
  const result = await measure(page, `/?scenario=dp-board&rows=${ROWS}${LIMIT}`);
  console.log(`PERF ${JSON.stringify({ rows: ROWS, limit: process.env.DP_LIMIT ?? null, ...result })}`);
  expect(result.rowsInDom).toBeLessThanOrEqual(120);
});
