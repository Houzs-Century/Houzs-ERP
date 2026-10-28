// SPA fallback Pages Function — defensive belt for `_redirects`.
//
// Why this exists:
//   The Cloudflare Pages git-integration auto-build for this project
//   intermittently omits `_redirects` from the deploy output (see Task #6
//   in the session log). When that file is missing, every non-`/` SPA
//   route (e.g. `/scm/categories`, `/scm/products`, `/system-health`)
//   returns a 404 page instead of the React shell. We've had to
//   re-deploy manually four times today to bring the site back.
//
//   Pages Functions, on the other hand, are read straight out of
//   `frontend/functions/` by Cloudflare every deploy — they don't depend
//   on Vite copying any file out of `public/`. So as long as the
//   functions directory itself reaches the deploy, this handler runs.
//
// What this handler does:
//   For any request that doesn't match a real static asset, serve the
//   pre-built `index.html`. The React Router on the client picks the
//   path up from `window.location` and renders the right page.
//
// Routing precedence (Cloudflare Pages):
//   1. Static assets that exist on disk (CSS, JS, images, the asset
//      pipeline's own /assets/* hashes) — served directly, this Function
//      never runs.
//   2. `_redirects` rules — when the file is present, the `/* /index.html
//      200` rule fires first, and this Function never runs.
//   3. Pages Functions — this `[[path]]` catchall is the final tier; it
//      only sees requests that fell through both of the above.
//
// Edge cases:
//   · A request for a real-looking file path that doesn't exist (e.g.
//     /robots.txt when we haven't shipped one) — we let CF Pages return
//     the 404 instead of serving `index.html`, otherwise broken `<img>`
//     tags would render the React shell.
//
// This file uses self-contained types so we don't have to add
// `@cloudflare/workers-types` to the frontend's devDependencies just
// for one file. Cloudflare types-checks Functions during deploy.

interface PagesContext {
  request: Request;
  env: { ASSETS: { fetch: (request: Request | string | URL) => Promise<Response> } };
  next: () => Promise<Response>;
}

// ── Canonical-domain redirect ──────────────────────────────────────────────
// Owner 2026-07: "我要全部看到 .houzscentury.com". Production answers on both
// `erp.houzscentury.com` and the Pages default host `houzs-erp.pages.dev`;
// bounce the latter to the former.
//
// DELIBERATELY DUPLICATED from `frontend/src/lib/canonicalHost.ts` rather than
// imported. This Function is the SPA fallback for the entire site — if its
// bundle ever failed to build, every route 404s. It has been kept
// dependency-free since it was written, and a cosmetic redirect is not worth
// spending that safety margin. `frontend/src/lib/canonicalHost.test.ts` pins
// the two copies to identical behaviour so they cannot drift silently.
//
// Exact host match only: staging (`houzs-erp-staging.pages.dev`, a different
// Pages project on a different Supabase database), previews
// (`<hash>.houzs-erp.pages.dev`), and `erp.2990shome.com` (whose hostname
// selects the default COMPANY) must all be left untouched. See
// canonicalHost.ts for the full rationale.
const LEGACY_PROD_HOST = "houzs-erp.pages.dev";
const CANONICAL_PROD_ORIGIN = "https://erp.houzscentury.com";

export function canonicalRedirectUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== LEGACY_PROD_HOST) return null;
  return `${CANONICAL_PROD_ORIGIN}${url.pathname}${url.search}${url.hash}`;
}

// A request is a top-level document navigation — the thing whose address bar we
// actually want to move — when the browser says so via `Sec-Fetch-Dest:
// document`, or (for the rare client that omits that header) when it Accepts
// HTML and the path is not a file. ONLY these are redirected; see the note on
// the redirect below for why /sw.js and hashed assets must NOT be.
function isDocumentNavigation(request: Request, url: URL): boolean {
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest) return dest === "document";
  const accept = request.headers.get("Accept") || "";
  const lastSegment = url.pathname.split("/").pop() ?? "";
  return accept.includes("text/html") && !lastSegment.includes(".");
}

// A CLOSED LIST, not "anything with a dot", and the difference is a regression
// this fix nearly shipped. The dotted-path branch below has always ended in
// `next()`, so a SPA route whose last segment happens to contain a dot
// (`/customers/john.doe`, a doc number, a slug carrying a domain) fell through
// to the `_redirects` catch-all and WORKED — by accident, on the very fallback
// this change exists to stop. Converting every non-.html dotted miss into a 404
// would have taken those routes down. So only extensions that are unambiguously
// static files are eligible; anything else keeps the shell exactly as before.
const STATIC_ASSET_EXTENSION =
  /\.(?:m?js|cjs|css|map|json|webmanifest|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|mp4|webm|wasm|txt|xml)$/i;

function isHtmlResponse(response: Response): boolean {
  return /text\/html/i.test(response.headers.get("content-type") ?? "");
}

export const onRequest = async ({ request, env, next }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);

  // Canonical domain — but ONLY for top-level document navigations. The service
  // worker script (/sw.js) and hashed /assets/* must be served normally on the
  // legacy host, NEVER redirected:
  //   - A redirected /sw.js FAILS the service-worker update. The browser fetches
  //     the worker script with redirect mode "error", so a 302 there aborts the
  //     update and freezes every already-installed pages.dev client on its old,
  //     cache-first shell FOREVER — it can never fetch a corrected worker. That
  //     is exactly what defeated the first cut of this redirect (#855): the edge
  //     302'd everything, /sw.js included, so no fixed worker could reach the
  //     clients that needed it, and the stale shell kept the app on pages.dev.
  //   - Redirecting an /assets/<hash>.js cross-origin would hand a stale open
  //     tab the canonical build's different hash (404 / wrong file).
  // Navigations still get the 302 (a fresh visitor lands on the canonical host);
  // the updated worker (public/sw.js) moves clients that already have it.
  const canonical = canonicalRedirectUrl(request.url);
  if (canonical && isDocumentNavigation(request, url)) {
    return new Response(null, { status: 302, headers: { Location: canonical } });
  }

  // File-looking paths (anything with a dot in the last segment) are
  // explicit asset requests — let the static-asset 404 reach the browser
  // so that broken <img> / fetch() calls show up as 404s instead of HTML.
  const lastSegment = url.pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) {
    const response = await next();
    // ...but `next()` is NOT the end of the chain. `public/_redirects` is a single
    // `/*  /index.html  200`, so a MISSING file falls through this Function, misses
    // on disk, and comes back as the SPA shell with status **200**. Under a code
    // URL that is the edge-poison outage of 2026-07-31 in one line: the browser
    // fails the module import ("expected a JavaScript-or-Wasm module script but the
    // server responded with a MIME type of text/html"), and because the status is
    // 200 the CDN happily caches that HTML *under the asset's own URL* for the
    // whole TTL. Deploys have a propagation window where index.html is live and a
    // hashed chunk is not, so every deploy is a chance to poison a PoP — the
    // 2026-07-31 11:08 deploy did exactly that, 12 times in 100 seconds, from the
    // CI runner's PoP. A real 404 cannot be mistaken for a chunk and `no-store`
    // keeps it out of every cache, so the window closes on its own.
    // Paths that are legitimately HTML keep the shell.
    if (STATIC_ASSET_EXTENSION.test(lastSegment) && isHtmlResponse(response)) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return response;
  }

  // Everything else is a SPA route. Serve the shell.
  return env.ASSETS.fetch(new URL("/index.html", request.url));
};
