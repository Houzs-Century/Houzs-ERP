// Pages middleware — attaches a REPORT-ONLY Content-Security-Policy to HTML
// document responses across the whole SPA (every route, including deep links),
// without touching the merge-fragile public/_headers file.
//
// Why report-only (audit H6): browsers only REPORT violations to the console,
// they NEVER block, so this cannot break the app. It is the defense-in-depth
// layer under the stored-XSS fixes — even if an XSS ever lands, a tight
// script-src is what stops the session token in localStorage being exfiltrated.
//
// How to graduate it (owner / dev, over ~a week):
//   1. Deploy this and confirm the header appears:
//        curl -sI https://erp.houzscentury.com/ | grep -i content-security-policy
//      (It only decorates text/html responses; assets are untouched.)
//   2. Use the site normally and watch the browser console for
//      "Content-Security-Policy-Report-Only" violation lines.
//   3. Widen the directives below for anything legitimate that reports (a real
//      third-party the app loads), then rename the header from
//      `Content-Security-Policy-Report-Only` to `Content-Security-Policy` to
//      ENFORCE. Only then does it start blocking.
//
// Self-contained types, matching the sibling [[path]].ts — no need to pull
// @cloudflare/workers-types into the frontend devDependencies for one file.

interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
}

// Starting policy: tight where it matters (script-src 'self' — no inline/eval),
// realistic where the app needs it (style-src 'unsafe-inline' for React/CSS-in-JS
// runtime styles; img data:/blob: for previews/canvas). connect-src lists the
// same-origin API plus the legacy workers.dev host still referenced in the bundle.
// Tighten these as the report-only run reveals what is actually loaded.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://autocount-sync-api.houzs-erp.workers.dev",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

export const onRequest = async ({ next }: PagesContext): Promise<Response> => {
  const response = await next();
  const contentType = response.headers.get("Content-Type") || "";
  // Only decorate HTML documents — the CSP that matters governs the page, and
  // touching asset responses would be pointless noise.
  if (!contentType.includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
