import { expect, type Locator, type Page } from "@playwright/test";

export async function nextFrames(page: Page, count = 2) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

export async function scrollWindowToRealEnd(page: Page) {
  // Virtualized variable-height content may correct its total after measuring a
  // newly mounted tail window. Re-clamp a fixed number of animation frames;
  // there is no wall-clock threshold and no guessed over-scroll constant.
  for (let pass = 0; pass < 4; pass++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await nextFrames(page, 2);
  }
  const geometry = await page.evaluate(() => ({
    actual: window.scrollY,
    maximum: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  }));
  expect(Math.abs(geometry.actual - geometry.maximum)).toBeLessThanOrEqual(1);
}

export async function expectBounded(locator: Locator, maximum: number) {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(maximum);
}
