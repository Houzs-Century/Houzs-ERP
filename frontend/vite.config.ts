import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Dev-server proxy rules.
//
// The frontend bundle calls the Cloudflare Worker at relative paths
// (/api/*, /portal/*, /track, /survey/*). In production those paths
// are served by the same origin as the bundle (via the Pages/Worker
// routing you already have). In `vite dev` there's nothing listening
// on those paths, so Vite returns the SPA index.html — which then
// parses as HTML and throws:
//   "Unexpected token '<', '<!doctype'... is not valid JSON"
//
// The proxy below forwards those paths to the Worker so dev works
// identically to production. Override the target via .env:
//
//   VITE_DEV_API_PROXY_TARGET=http://localhost:8787    # wrangler dev
//   VITE_DEV_API_PROXY_TARGET=https://autocount-sync-api.houzs-erp.workers.dev
//
// Default points at the deployed worker so `npm run dev` is usable
// with zero config as long as you're happy hitting remote.
export default defineConfig(({ mode }) => {
  // loadEnv reads from the current working directory; Vite always
  // runs from the project root so "" is correct. Using "" avoids
  // the Node-typed `process.cwd()` which tsc without @types/node
  // can't type-check.
  const env = loadEnv(mode, "", "");
  const target =
    env.VITE_DEV_API_PROXY_TARGET ||
    "https://autocount-sync-api.houzs-erp.workers.dev";

  const proxyRule = {
    target,
    changeOrigin: true,
    secure: true,
  };

  // One id per build. Used for BOTH the localStorage snapshot namespace
  // (__BUILD_ID__ define) and the service-worker cache VERSION (stamped into
  // dist/sw.js below), so a deploy can never accidentally reuse either.
  const buildId = Date.now().toString(36);

  return {
    resolve: {
      // Array form (find/replacement) — required because the react-router
      // entry uses a regex find; Vite forbids mixing object-map + array forms.
      alias: [
        // Pin the bare `zod` import to this app's own copy so Rollup resolves
        // it deterministically on a clean CI build. Exact-match so it doesn't
        // also rewrite e.g. "zod/lib".
        {
          find: /^zod$/,
          replacement: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
        },
        // ── Vendored 2990's SCM slice (Suppliers proof of concept) ──
        // The wholesale-copied 2990 pages/components import these bare
        // specifiers; map them onto the vendored copies under src/vendor.
        {
          find: /^@2990s\/design-system$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/design-system/index.ts", import.meta.url)
          ),
        },
        // @2990s/shared/phone + /mfg-pricing (subpaths) MUST precede
        // @2990s/shared so the longer specifier matches first.
        {
          find: /^@2990s\/shared\/phone$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/phone.ts", import.meta.url)
          ),
        },
        // @2990s/shared/mfg-pricing — the PO pages import the cost engine
        // (computeMfgPoUnitCost) via this dedicated subpath, matching 2990's.
        {
          find: /^@2990s\/shared\/mfg-pricing$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/mfg-pricing.ts", import.meta.url)
          ),
        },
        // @2990s/shared/payment-methods — the SO PaymentsTable + SO Maintenance
        // page branch on the L1 method vocabulary via this dedicated subpath.
        {
          find: /^@2990s\/shared\/payment-methods$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/scm/lib/payment-methods.ts", import.meta.url)
          ),
        },
        // @2990s/shared/so-variant-rule — SoLineCard + the sales-order/* types
        // import the required-variant rule via this dedicated subpath (it's also
        // re-exported by the @2990s/shared barrel, but the source uses the
        // subpath, so keep it verbatim).
        {
          find: /^@2990s\/shared\/so-variant-rule$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/so-variant-rule.ts", import.meta.url)
          ),
        },
        // @2990s/shared/so-line-display — the real PDF generators (PO/GRN/PI/PR/
        // SO/DO/DR/SI) import the canonical SO line ordering + PWP note helpers
        // via this dedicated subpath, matching 2990's source.
        {
          find: /^@2990s\/shared\/so-line-display$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/so-line-display.ts", import.meta.url)
          ),
        },
        {
          find: /^@2990s\/shared$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/shared/index.ts", import.meta.url)
          ),
        },
        // NOTE on 'react-router': the vendored 2990 pages import router bits
        // (useNavigate/useParams/Navigate) from the bare 'react-router'
        // specifier. No alias is needed — react-router v6.30 is already present
        // in node_modules as react-router-dom's own dependency and re-exports
        // those same hooks. (An earlier alias to react-router-dom broke the
        // build by rewriting react-router-dom's INTERNAL self-imports.)
        // DataGrid imports useVirtualizer from @tanstack/react-virtual, which
        // is NOT installed here (no npm install allowed). A dependency-free
        // shim reimplements the exact slice DataGrid uses.
        {
          find: /^@tanstack\/react-virtual$/,
          replacement: fileURLToPath(
            new URL("./src/vendor/scm/lib/react-virtual-shim.ts", import.meta.url)
          ),
        },
      ],
      // Force a single React/ReactDOM instance. The vendored 2990 modules
      // import router bits from the bare 'react-router' specifier, and as the
      // vendored graph grew Vite's dev dep-optimizer began splitting React into
      // two copies (symptom: "Invalid hook call" / useContext-of-null from
      // react-router's useNavigate). dedupe pins everything to one copy.
      dedupe: [
        "react",
        "react-dom",
        "react-router",
        "react-router-dom",
        // react-query is context-based too — a split copy makes the vendored
        // pages' useQuery miss the root QueryClientProvider ("No QueryClient set").
        "@tanstack/react-query",
      ],
    },
    plugins: [
      react(),
      // Stamp the build id into dist/sw.js (replacing the __SW_BUILD_ID__ token)
      // so the service-worker cache VERSION is unique per deploy → the SW's
      // activate step purges the previous deploy's caches automatically. Removes
      // the manual sw.js VERSION bump (forgotten bumps served a stale shell;
      // parallel branches even collided on the same vNNN). writeBundle only fires
      // on build, so dev (which doesn't register the SW) is unaffected.
      {
        name: "sw-build-version",
        writeBundle() {
          try {
            const swPath = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
            if (existsSync(swPath)) {
              writeFileSync(
                swPath,
                readFileSync(swPath, "utf8").replace(/__SW_BUILD_ID__/g, buildId),
              );
            }
          } catch (e) {
            console.warn("[sw-build-version] could not stamp sw.js:", e);
          }
        },
      },
    ],
    // Unique per build — namespaces the localStorage query snapshot
    // (src/lib/query-persist.ts) so a deploy that changes a list's payload shape
    // orphans the previous build's snapshot instead of hydrating a stale shape.
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
    build: {
      // Don't <link rel="modulepreload"> the heavy on-demand chunks (jspdf /
      // xlsx / leaflet). They're only ever reached via dynamic import() at a
      // print/export/map click, so preloading them makes a COLD first visit
      // eagerly download ~1MB of JS almost no session uses. Filtering them out of
      // the preload graph (they still load on demand) is a pure cold-load win —
      // HOOKKA's resolveDependencies trick.
      modulePreload: {
        resolveDependencies: (_filename, deps) =>
          deps.filter((d) => !/(jspdf|xlsx|leaflet)/i.test(d)),
      },
      rollupOptions: {
        // Cast is type-only: `codeSplitting` is Rolldown's chunking API, which
        // rollup's OutputOptions typings don't know yet — `tsc -b` (the first
        // half of `npm run build`) fails on the unknown key without it.
        output: ({
          // Stable vendor chunks keep framework bytes cacheable and move
          // heavyweights (leaflet maps, lucide icons) outside the entry.
          // Vite 8's Rolldown can additionally split modules shared by the
          // shell and lazy routes into many tiny eager chunks. Grouping the
          // `$initial` application graph removes that gzip/request overhead;
          // the reachability tag guarantees lazy-only pages stay lazy.
          codeSplitting: {
            groups: [
              {
                name: "react-vendor",
                test: /[\\/]node_modules[\\/](?:@tanstack[\\/]|react(?:-dom|-router|-router-dom)?[\\/]|scheduler[\\/])/,
                priority: 30,
              },
              {
                name: "leaflet",
                test: /[\\/]node_modules[\\/]leaflet[\\/]/,
                priority: 30,
              },
              {
                // Icons the SHELL actually renders (sidebar nav, top bar,
                // FABs…) — the `$initial` reachability tag limits this group to
                // entry-reachable lucide modules, exactly like `initial-app`
                // below. Split from the catch-all `lucide` group (2026-07-23)
                // because that chunk is the union of every icon ANY route uses
                // (~52 KB raw), and one eager shell import made ALL of it a
                // modulepreload on first paint. Route-only icons now stay in
                // `lucide`, which nothing eager references, so it loads with
                // the first route that needs it.
                name: "lucide-initial",
                test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
                tags: ["$initial"],
                priority: 35,
              },
              {
                name: "lucide",
                test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
                priority: 30,
              },
              {
                name: "initial-app",
                test: (id: string) => !id.includes("node_modules"),
                tags: ["$initial"],
                priority: 10,
              },
            ],
            // Everything else: let Rolldown assign the chunk from what actually
            // reaches the module.
            //
            // This used to be `return "vendor"`, which was a correctness bug,
            // not just a packaging choice. The rule above it excluded xlsx and
            // jspdf BY PACKAGE NAME so they would stay on-demand — but their
            // dependencies are separate node_modules directories, so the names
            // never matched them and they fell through to `vendor`. jspdf's
            // tree alone (dompurify, html2canvas, canvg, core-js, fflate,
            // @babel/runtime, ...) is most of that chunk's ~394 KB raw /
            // 117 KB gzip. And `vendor` IS eager: @remix-run/router lands
            // there too (react-router-dom's own dependency, matched by neither
            // name above), so the entry graph pulls the chunk in and every
            // cold load paid for a PDF stack that only a print click reaches.
            // Co-locating a lazy-only module with an eager one is what makes
            // it eager — the exclusion list defeated itself.
            //
            // Naming the transitive deps here instead would just re-arm the
            // same trap on the next dependency bump. Reachability is the thing
            // we actually mean, and Rolldown computes it for free.
          },
        } as any),
      },
    },
    server: {
      // Pin dev to 5173 so `npm run dev` doesn't drift up to 5174 /
      // 5175 / 5180 when another Vite is already running. strictPort
      // fails fast instead of auto-picking a random free port, which
      // matters here because the PWA service worker is registered
      // per-origin and stale registrations on other ports serve
      // cached bundles.
      port: 5173,
      strictPort: true,
      proxy: {
        // Only /api/* gets forwarded. SPA routes (/track,
        // /portal/case/:token, /survey/:token, etc.) fall through to
        // Vite so index.html + React Router handle them.
        "/api": proxyRule,
      },
    },
  };
});
