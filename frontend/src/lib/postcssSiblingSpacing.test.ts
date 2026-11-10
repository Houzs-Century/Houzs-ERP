/* The app's CSS must not carry Tailwind 3's `:not([hidden]) ~ :not([hidden])`
   sibling selector: with it, every row a windowed table adds or removes
   restyles all the rows after it (154 ms vs 19 ms per 10-row scroll step on
   the 3,000-row Delivery Planning board). See postcss-sibling-spacing.js. */
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import siblingSpacing, { rewriteSiblingSelector } from "../../postcss-sibling-spacing.js";
import config from "../../postcss.config.js";

describe("postcss sibling-spacing rewrite", () => {
  it("turns the space/divide sibling selector into a first-child test", () => {
    expect(rewriteSiblingSelector(".space-y-2 > :not([hidden]) ~ :not([hidden])"))
      .toBe(".space-y-2 > :not([hidden]):not(:first-child)");
    expect(rewriteSiblingSelector(".peer:checked ~ .x")).toBe(".peer:checked ~ .x");
  });

  it("leaves no `~` sibling selector in what Tailwind generates for space-* and divide-*", async () => {
    const out = await postcss([
      tailwindcss({
        content: [{ raw: '<div class="space-y-2 space-x-3 -space-x-2 divide-y divide-x space-x-reverse">', extension: "html" }],
        corePlugins: { preflight: false },
      }),
      siblingSpacing(),
    ]).process("@tailwind utilities;", { from: undefined });
    expect(out.css).toContain(".space-y-2 > :not([hidden]):not(:first-child)");
    expect(out.css).toContain(".divide-y > :not([hidden]):not(:first-child)");
    expect(out.css).not.toContain("~");
  });

  it("is wired into the app's PostCSS config, after Tailwind", () => {
    const names = (config.plugins as Array<{ postcssPlugin?: string }>).map((p) => p.postcssPlugin);
    expect(names.indexOf("houzs-sibling-spacing")).toBeGreaterThan(names.indexOf("tailwindcss"));
  });
});
