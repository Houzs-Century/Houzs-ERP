import { Hono } from "hono";
import type { Env } from "../types";

// Companies list for the top-bar company switcher — Phase 0c of the
// multi-company merge. Reads what companyContext (mounted on /api/*) already
// resolved and stashed on the Hono context; NO DB read of its own. Any
// authenticated user may call it — the switcher is a UI affordance, not a
// gated admin surface, so no new permission verb is introduced.
//
// NO-OP property: pre-activation (companies master absent), companyContext
// leaves the context vars undefined, so this returns { companies: [] } and the
// front-end switcher stays hidden. Single-company Houzs is unchanged.
//
// DELIBERATELY UNCACHED (perf/hot-config-cache): the response is PER-USER
// (filtered by the caller's user_companies grants) AND per-request (the
// active company follows the X-Company-Id header) — so it may never enter a
// shared cache — and the handler performs NO DB read of its own; its entire
// latency is the auth + companyContext middleware, which a route-level cache
// cannot skip. Nothing to win, a grant-leak class to lose.

const app = new Hono<{ Bindings: Env }>();

/** GET /api/companies — active companies + which one is active for this request. */
app.get("/", (c) => {
  // Filter the switcher list to the companies this user is actually granted
  // (companyContext computes allowedCompanyIds; it fails OPEN to all companies
  // when the user has no user_companies grants, so this is a no-op today and
  // only bites once a user is restricted). Without this the switcher would offer
  // a company the user can't use — companyContext then ignores the disallowed
  // X-Company-Id and serves the hostname default, so the header would say one
  // company while the data is another. No data leak (backend enforces), but a
  // confusing mislabel — so we don't offer what we won't honour.
  // Three states (see the sentinel doc on companyScope.allowedCompanyIds):
  // undefined = unresolved → offer the full list (pre-activation behaviour);
  // otherwise offer exactly the granted set — including `[]`, where the caller
  // is granted no active company and the switcher must offer nothing rather
  // than every company.
  const all = (c.get("companies") as { id: number }[] | undefined) ?? [];
  const allowed = c.get("allowedCompanyIds") as number[] | undefined;
  const companies = allowed ? all.filter((co) => allowed.includes(co.id)) : all;
  return c.json({
    companies,
    activeCompanyId: c.get("companyId") ?? null,
    activeCompanyCode: c.get("companyCode") ?? null,
  });
});

export default app;
