import { defineConfig, mergeConfig, type UserConfig } from "vitest/config";
import viteConfig from "./vite.config";

// The ratcheted areas, from the ONE list scripts/coverage-ratchet.mjs also
// reads, so what vitest instruments and what the gate audits cannot drift.
import { includeGlobsFor } from "../scripts/coverage-areas.mjs";

// Reuse the app's own resolve.alias (@2990s/*, the SCM vendor shims, the
// pinned zod) so a component test resolves imports exactly like the build
// does — a second, hand-maintained alias list is how test-only drift starts.
export default defineConfig(async (env) => {
  const base = (await (viteConfig as any)(env)) as UserConfig;
  return mergeConfig(base, {
    test: {
      environment: "jsdom",
      globals: false,
      // Registers afterEach(cleanup) so RTL unmounts each rendered tree, running
      // its effect cleanups and clearing timers those effects scheduled. Under
      // globals:false, RTL does NOT auto-register this, so without it every
      // render() stays mounted for the whole process and a leaked timer fires
      // after teardown as "window is not defined". See src/test-setup.ts and the
      // leaked-timer entries in BUG-HISTORY.
      setupFiles: ["./src/test-setup.ts"],
      // Default is 5000ms. Several component tests legitimately run 4.5-6s under
      // CI load (jsdom + a large render + fake-timer flushes), so they brush the
      // default and fail at random — a SEPARATE flake class from the leaked
      // timer above, same visible symptom (CI red, frontend release skipped).
      // 15s gives real headroom without hiding a genuinely hung test.
      testTimeout: 15000,
      hookTimeout: 15000,
      // `functions/` is the Cloudflare Pages SPA fallback. It shipped with no
      // local coverage at all — tsconfig.app.json included only `src`, so
      // `tsc --noEmit` never read it and vitest never ran anything in it, and
      // the only thing type-checking it was Cloudflare at deploy time. That gap
      // is how a routing bug that returns the app shell under every missing
      // .js URL survived (see BUG-HISTORY 2026-07-31).
      include: ["src/**/*.test.ts", "src/**/*.test.tsx", "functions/**/*.test.ts"],
      // v8 here (the backend must use istanbul — workerd has no node:inspector).
      // `all: true` is what puts the UNTESTED files in the denominator; without
      // it the percentage is "how well covered are the files that have tests",
      // which is not a number anyone wants. Measured cost: ~5s on top of an 18s
      // suite, so this is affordable on every PR.
      coverage: {
        provider: "v8",
        all: true,
        include: includeGlobsFor("frontend", "frontend"),
        reporter: ["text-summary", "json"],
        reportsDirectory: "./coverage",
      },
    },
  } as UserConfig);
});
