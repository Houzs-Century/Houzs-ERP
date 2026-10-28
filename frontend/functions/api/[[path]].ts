// Same-origin API proxy — forwards /api/* to the backend Worker.
//
// Why this exists (2026-07-09):
//   The frontend used to call the Worker directly at its *.workers.dev
//   origin. Some Malaysian mobile carriers intermittently block or fail to
//   resolve *.workers.dev, which surfaced as field staff (drivers) getting
//   "Network error — the server took too long to respond" on the login
//   screen while the Worker was perfectly healthy. Routing API calls
//   through the app's own origin (erp.houzscentury.com) sidesteps that
//   entirely — the phone only ever talks to one domain, and the Pages→
//   Worker hop happens inside Cloudflare's network.
//
//   A Worker custom domain (api.houzscentury.com) would also solve this,
//   but houzscentury.com's DNS zone is not hosted in this Cloudflare
//   account, so custom domains can't attach (wrangler error 10082 — and
//   note: putting `routes` in wrangler.toml implicitly DISABLES the
//   workers.dev endpoint, which briefly took prod down on 2026-07-09;
//   don't retry that without onboarding the zone first).
//
// Routing precedence: this /api/[[path]].ts is more specific than the root
// [[path]].ts SPA catch-all, so API requests land here first. The service
// worker deliberately does not intercept /api/* (see public/sw.js).
//
// The workers.dev URL keeps serving as before — older cached bundles that
// still call it directly continue to work.

interface PagesContext {
  request: Request;
  env: { API_ORIGIN?: string };
}

const DEFAULT_API_ORIGIN = "https://autocount-sync-api.houzs-erp.workers.dev";

export const onRequest = async ({ request, env }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);
  // API_ORIGIN Pages env var overrides the target (e.g. point a preview
  // project at the staging Worker) — unset means production.
  const origin = env.API_ORIGIN || DEFAULT_API_ORIGIN;
  const upstream = `${origin}${url.pathname}${url.search}`;
  // Forward the request verbatim (method, headers, streamed body). fetch()
  // sets the Host header from the upstream URL. Responses stream back.
  return fetch(upstream, request);
};
