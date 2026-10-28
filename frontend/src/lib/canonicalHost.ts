// ---------------------------------------------------------------------------
// canonicalHost.ts — send production traffic to the canonical custom domain.
//
// Owner ruling (2026-07): "我要全部看到 .houzscentury.com". Production is
// reachable on BOTH the custom domain `erp.houzscentury.com` and the
// Cloudflare Pages default hostname `houzs-erp.pages.dev` (same deploy, same
// database) — the owner hit `houzs-erp.pages.dev/assistant` and got the full
// working app. Every hit should land on the custom domain instead.
//
// Ported from the sibling HOOKKA ERP, which solved the same problem
// (`src/lib/app-origin.ts` there). NOTE the deliberate difference: HOOKKA only
// canonicalised URLs it BAKED INTO QR codes and printed stickers — it never
// redirected the browser, so its pages.dev host still serves the app today.
// Houzs goes one step further and actually redirects, because the owner wants
// to SEE the canonical domain in the address bar, not merely receive links
// that carry it.
//
// ── WHY THIS MATCHES ONE EXACT HOST AND NOT `*.pages.dev` ──────────────────
// A blanket "redirect anything that isn't houzscentury.com" rule would break
// three real things. Each is a concrete, named breakage — not a hypothetical:
//
//   1. `houzs-erp-staging.pages.dev` — a SEPARATE Cloudflare Pages project
//      (.github/workflows/deploy-staging.yml deploys `--project-name=
//      houzs-erp-staging`) pointed at a DIFFERENT Supabase project
//      (staging `minnapsemfzjmtvnnvdd` vs prod `anogrigyjbduyzclzjgn`).
//      backend/wrangler.toml:186 sets its own PUBLIC_APP_URL. Redirecting it
//      would silently move every staging tester onto PRODUCTION DATA.
//
//   2. `erp.2990shome.com` — a custom domain serving this SAME app for the
//      other company. `backend/src/middleware/companyContext.ts`
//      (`defaultCompanyCodeForHost`) reads the hostname to decide the default
//      company: a host containing "2990" starts in company 2990, everything
//      else in HOUZS. Redirecting that host to houzscentury.com would drop
//      2990 staff into the wrong company's default context.
//
//   3. Preview deploys `<hash>.houzs-erp.pages.dev` — see the note below.
//
// So: match the production Pages host EXACTLY. Everything else — staging,
// previews, 2990's domain, the canonical domain itself, and localhost — is
// left completely alone.
//
// ── ARE PREVIEW DEPLOYS ACTUALLY USED? ────────────────────────────────────
// Checked, because a previous caution against touching `*.pages.dev` rested on
// them. Answer: no CI workflow creates them. `.github/workflows/deploy.yml`
// deploys to project `houzs-erp` on `branches: [main]` only, and
// `deploy-staging.yml` deploys to the separate `houzs-erp-staging` project on
// `[main, staging]`. There is no PR/preview deploy job. Preview hosts are
// nonetheless excluded here because exact-host matching gives that for free
// and costs nothing — not because a preview workflow exists to protect.
//
// ── TEMPORARY, NOT PERMANENT ──────────────────────────────────────────────
// 302, deliberately. A 301 is cached hard by browsers and is painful to undo
// if this needs reverting. Promote to 301 only once this is proven in the
// wild.
//
// ── EXPECTED SIDE EFFECT: SESSIONS DO NOT CARRY OVER ──────────────────────
// Auth tokens live in localStorage (frontend/src/api/client.ts `tokenStore`),
// which is per-ORIGIN. Anyone signed in on `houzs-erp.pages.dev` today will
// land on the login screen once on the canonical domain and must sign in
// again. That is expected and correct, not a bug — the two origins never
// shared storage.
// ---------------------------------------------------------------------------

/** The Cloudflare Pages default hostname for the PRODUCTION project. */
export const LEGACY_PROD_HOST = "houzs-erp.pages.dev";

/** The canonical user-facing origin. Matches backend PUBLIC_APP_URL. */
export const CANONICAL_PROD_ORIGIN = "https://erp.houzscentury.com";

/**
 * Given a full URL, return the canonical URL to redirect to, or `null` when
 * the URL is already on an origin we must leave alone.
 *
 * Preserves path, query string and hash exactly — a deep link stays a deep
 * link, so a bookmarked `/scm/sales-orders/SO-2607-015` survives the hop.
 *
 * Pure and total: a malformed URL yields `null` (no redirect) rather than
 * throwing, so this can never take the app down.
 */
export function canonicalRedirectUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // Exact host match only. `houzs-erp-staging.pages.dev` does not match;
  // neither does `<hash>.houzs-erp.pages.dev`, `erp.2990shome.com`, the
  // canonical domain itself, or localhost.
  if (url.hostname.toLowerCase() !== LEGACY_PROD_HOST) return null;

  return `${CANONICAL_PROD_ORIGIN}${url.pathname}${url.search}${url.hash}`;
}
