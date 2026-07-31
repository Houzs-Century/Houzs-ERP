import { defineConfig, mergeConfig, type UserConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Reuse the app's own resolve.alias (@2990s/*, the SCM vendor shims, the
// pinned zod) so a component test resolves imports exactly like the build
// does — a second, hand-maintained alias list is how test-only drift starts.
export default defineConfig(async (env) => {
  const base = (await (viteConfig as any)(env)) as UserConfig;
  return mergeConfig(base, {
    test: {
      environment: "jsdom",
      globals: false,
      // `functions/` is the Cloudflare Pages SPA fallback. It shipped with no
      // local coverage at all — tsconfig.app.json included only `src`, so
      // `tsc --noEmit` never read it and vitest never ran anything in it, and
      // the only thing type-checking it was Cloudflare at deploy time. That gap
      // is how a routing bug that returns the app shell under every missing
      // .js URL survived (see BUG-HISTORY 2026-07-31).
      include: ["src/**/*.test.ts", "src/**/*.test.tsx", "functions/**/*.test.ts"],
    },
  } as UserConfig);
});
