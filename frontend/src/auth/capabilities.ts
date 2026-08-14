/**
 * capabilities — the client half of the backend-resolved permission answer set.
 *
 * Owner's architectural ruling, 2026-07-19:
 *   "我们的权限全部要用 backend 来做，这样子它连渲染都不需要渲染，
 *    frontend 那边就不会那么忙。"
 *
 * This module CONTAINS NO POLICY, and that is the entire point. It reads
 * booleans the server already decided (backend/src/services/capabilities.ts,
 * resolved once per /auth/me) and hands them to a component. There is no
 * position name in this file, no regex, no permission-key union, no OR of two
 * rules — because every one of those, on this side of the wire, is a SECOND COPY
 * of a backend rule, and the second copy is always the one that goes stale.
 *
 * The three confirmations that produced the ruling, all on one day:
 *   1. SO Maintenance asked `can('scm.config.write')` — the flat key ALONE —
 *      while the API had accepted `flat OR positionPolicy.canWriteConfig` since
 *      2026-07-18. It told position-granted config writers the page was
 *      read-only over writes the API would have taken.
 *   2. Seven reference reads on that page wrapped results in `?? []`, so a 403
 *      rendered as an empty dropdown. "You are not allowed" became "there is
 *      nothing".
 *   3. MobileApp's `allowed()` fails OPEN — a path with no nav entry is visible
 *      to everyone.
 *
 * ── HOW TO USE ──────────────────────────────────────────────────────────────
 *
 *   const canOpen = useCapability("scm.maintenance.open");
 *   if (!canOpen) return null;              // ABSENT, not disabled, not hidden
 *
 * "Off" in this project means the nav row is GONE, the route does NOT mount, and
 * the query is `enabled: false`. A disabled button still advertises a feature; a
 * mounted route still fires its data hooks, which is the performance cost the
 * owner is objecting to. Make it absent.
 *
 * ── FAILING CLOSED ──────────────────────────────────────────────────────────
 *
 * No `?? true`. No `?? []`. No `|| {}` default. An unknown answer is NO.
 *
 * A signed-in user whose /auth/me carried no `capabilities` object at all is a
 * BROKEN DEPLOYMENT, not a user without permissions — see `capabilitiesUnresolved`.
 * Every capability reads false in that state, and the condition must be
 * SURFACED, because silently hiding half the app is the outage nobody reports:
 * people simply stop using the feature and never file a ticket.
 */

import { useAuth } from "./AuthContext";
import type { AuthUser } from "../types";

/**
 * The capability vocabulary. MUST stay identical to `CAPABILITY_KEYS` in
 * backend/src/services/capabilities.ts — pinned by capabilities.test.ts, which
 * reads that file and compares the two lists. A key added on one side only
 * fails CI rather than resolving to a silent denial on a screen nobody rechecked.
 *
 * These are ANSWERS ("may you open SO Maintenance"), not grants ("do you hold
 * scm.config.write"). If you find yourself wanting to combine two of them with
 * `||` at a call site, that combination is a rule, and rules live on the server:
 * add the composed capability to the backend registry instead.
 */
export const CAPABILITY_KEYS = [
  "fair.do.view",
  "fair.invoice.view",
  "fair.report.view",
  "fair.so.view",
  "org.director",
  "org.sales.staff",
  "org.salesDirector",
  "scm.config.write",
  "scm.finance.view",
  "scm.maintenance.open",
  "scm.money.move",
  "scm.productCost.view",
  "scm.sales.viewAll",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * True when this user's capability set could NOT be resolved — the server did
 * not send one. Distinct from "every capability is false", which is a legitimate
 * answer for a genuinely unprivileged user.
 *
 * In practice this means a new SPA shell is talking to a Worker that predates
 * the capabilities response (a cached PWA shell, or a Pages deploy that landed
 * ahead of the Worker deploy). Every gate reads false in that state, so the
 * failure mode is safe but LOUD is better than safe-and-silent: a caller that
 * can show a message should show one, and it should say "we could not load your
 * permissions", never "you do not have permission" — the two send an operator
 * to completely different people.
 */
export function capabilitiesUnresolved(user: AuthUser | null | undefined): boolean {
  return !!user && !user.capabilities;
}

/**
 * Read ONE server-decided answer. Fails closed on every axis: no user, no
 * capability set, an absent key, or any value that is not literally `true`.
 *
 * The `=== true` is deliberate and is not paranoia about types. It is the
 * difference between "the server said no" and "the server said nothing", and it
 * makes the two behave identically at the call site so that no future edit can
 * accidentally let `undefined` mean yes.
 */
export function capability(
  user: AuthUser | null | undefined,
  key: CapabilityKey,
): boolean {
  if (!user) return false;
  const caps = user.capabilities;
  if (!caps) return false;
  return caps[key] === true;
}

/**
 * Hook form — the ergonomic call site. `useCapability("scm.money.move")`.
 *
 * Deliberately returns a bare boolean rather than an object: a gate that has to
 * be destructured invites a caller to read only the half they remembered, and
 * the half people forget is always the denial.
 */
export function useCapability(key: CapabilityKey): boolean {
  const { user } = useAuth();
  return capability(user, key);
}

