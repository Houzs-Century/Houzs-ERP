// Retry policy — one retry for a blip, NONE for a decision.
//
// WHY THIS FILE EXISTS
// -------------------
// A bare `retry: 1` re-sends every failure once, including authorization
// failures. A 403 is a DECISION, not a blip: the second call cannot succeed. It
// buys nothing and costs three things —
//   1. the operator waits a full retryDelay longer for the error banner,
//   2. the Worker serves double the requests, and
//   3. an incident that 4xxs broadly doubles its own request volume, which is
//      exactly when you least want that.
// This was observed in production on 2026-07-19: the owner's DevTools showed
// /inventory/warehouses, /delivery-planning-regions and .../states each 403
// TWICE on one SO Maintenance page load.
//
// `fix/so-maintenance-403-and-layout` (PR #825) fixes the GLOBAL default in
// lib/queryClient.ts. It does not — and cannot — reach the 94 per-hook
// `retry: 1` overrides scattered across the vendored SCM query layer, because
// an explicit callsite option always beats a default. Those overrides cover
// every SCM document module the owner touches daily: Sales Orders, Delivery
// Orders, Sales Invoices, Amendments, Purchase Orders, GRN, Purchase Invoices,
// Purchase/Delivery Returns, Consignment, Stock, Suppliers and HR. This module
// is the ONE predicate they all now share.
//
// WHEN #825 LANDS: replace the inline copy of this predicate in
// lib/queryClient.ts with `import { retryUnlessClientError } from "./retryPolicy"`.
// Two copies of a policy is how a policy drifts.
//
// ERROR SHAPES
// ------------
// Both error shapes in this app carry a numeric `.status`:
//   - api/client.ts's `HttpError` (the core Houzs client), and
//   - the vendored SCM `authedFetch`, which does
//       `const err = new Error(humanApiError(res.status, body)); err.status = res.status;`
//     (vendor/scm/lib/authed-fetch.ts).
// Anything without a `.status` is a network-layer failure (DNS, offline, an
// aborted fetch) — genuinely transient, so it keeps its retry.
//
// NOTE ON 5xx: a retry here is deliberate and load-bearing, not politeness.
// Hyperdrive answers a cold pool with 503 and self-heals; see the cold-start
// entries in BUG-HISTORY.md. (The vendored authedFetch ALSO rides out 503 and
// network drops internally on GETs; this predicate sits on top of that and is
// the last line, not the first.)

/** Numeric HTTP status off either error shape, or undefined for a network-layer failure. */
function statusOf(error: unknown): number | undefined {
  const s = (error as { status?: unknown } | null | undefined)?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * TanStack Query `retry` predicate: retry once, but never for a 4xx the server
 * has already decided on.
 *
 * 408 (Request Timeout) and 429 (Too Many Requests) are the two 4xx codes that
 * literally mean "try again", so they keep the retry.
 *
 * NOTE THE `Error` PARAMETER TYPE — it is load-bearing, not decoration.
 * TanStack infers a query's `TError` from the options object, and a `retry`
 * predicate typed `(n: number, error: unknown)` widens `TError` to `unknown` for
 * every query that uses it. That is not a type-only wrinkle: fifteen pages
 * render `{error && <Banner>{error.message}</Banner>}`, and an `unknown` error
 * makes those fail to compile (and, if forced through, renders an unknown value
 * as a ReactNode). `Error` is TanStack's own default and keeps every callsite's
 * inference exactly as it was. Both real error shapes here extend Error.
 */
export function retryUnlessClientError(failureCount: number, error: Error): boolean {
  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  return failureCount < 1;
}
