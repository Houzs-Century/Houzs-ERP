import type { Context, MiddlewareHandler } from "hono";
import type { Env, Variables } from "../env";
import type { AuthUser } from "../../services/auth";
import { meetsLevel, type AccessLevel } from "../../services/pageAccess";
import { salesJdDenial, salesJdWriteDenial } from "../../services/salesJdAccess";
import { moneyWriteDenial } from "../../services/positionPolicy";

// ── L2 per-area WRITE authorization for /api/scm/* ──────────────────────────
//
// SAFE, ADDITIVE layer on top of the coarse `requireScmAccess` umbrella that
// already gates /api/scm/* in the main index.ts. Each SCM sub-router is mounted
// in scm/index.ts behind `scmAreaGuard('<L2 area key>')`, which enforces the L2
// page-access matrix per HTTP method:
//
//   GET / HEAD            → require 'view'   (read)
//   POST / PATCH / PUT /  → require 'edit'   (write/void/delete)
//   DELETE
//
// NO-LOCKOUT ROLLOUT — the MATRIX half of the gate is enforced ONLY for users
// who already have an explicit SCM L2 configuration. Resolution order:
//   1. Owner / wildcard (`*`)        → next()  (bypass; never gated)
//   1.5 Sales JD deny (salesJdAccess.salesJdDenial) → 403  (ENFORCED ALWAYS)
//                                         A rule in code, not a matrix cell, so
//                                         it does NOT wait for the L2 rollout —
//                                         that is the difference between a rule
//                                         and a setting. Today: exactly
//                                         scm.sales.returns, for the Sales
//                                         cohort (owner 2026-07-17 "就是要关").
//   1.55 Sales JD write-cap (salesJdAccess.salesJdWriteDenial) → 403 on WRITES
//                                         The other half of the same rule: an area
//                                         SALES_JD caps at `view` (DO + SI) takes
//                                         writes away from the Sales cohort whether
//                                         or not they are L2-configured. Reads are
//                                         never denied — Sales keeps view + print.
//   1.6 Money-write deny (positionPolicy.moneyWriteDenial) → 403  (ENFORCED ALWAYS)
//                                         Owner 2026-07-18: default-full is about
//                                         SEEING, not doing. A WRITE on the finance
//                                         areas (journal entries / payment vouchers)
//                                         is Finance-only. Reads never denied, and
//                                         only the finance areas are in scope.
//   2. user.scm_l2_configured === true → require meetsLevel(level, required),
//                                         else 403  (ENFORCED)
//   3. otherwise (no SCM L2 rows)    → next()  (fall back to the coarse
//                                         scm.access umbrella already enforced
//                                         upstream — so no current scm.access
//                                         holder is locked out before the
//                                         matrix is seeded)
//
// IMPORTANT — middleware ordering: this runs from `scm.use('/<prefix>/*', ...)`
// in scm/index.ts, which executes BEFORE the mounted sub-router's own
// `router.use('*', supabaseAuth)`. supabaseAuth REPLACES c.get('user') with a
// Supabase system-staff shape; this guard reads the Houzs AuthUser while it is
// still intact. Hence the cast from the scm Variables.user (typed Supabase User)
// to AuthUser here.

const isWrite = (method: string): boolean =>
  method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";

/**
 * Options — least-privilege escape hatches for routes whose L2 "home" area is
 * an ADMIN area but whose consumers are ordinary staff (added 2026-07-04 to
 * unblock the mobile SO + scan flow for Members, e.g. Sales Executive with
 * scm.sales.* = view and everything else = none):
 *
 * - `openRead` — GET/HEAD skip the per-area check entirely (writes still
 *   enforce `edit` on the area). For SO-flow REFERENCE reads that happen to
 *   live under scm.procurement.products (so-dropdown-options, fabric-library,
 *   mfg-products, maintenance-config, product-models, special-addons): a
 *   salesperson filling an SO must read these picklists, but must NOT need
 *   view access to the whole Products admin area. Same spirit as the
 *   SHARED READ HELPERS left on the coarse umbrella in scm/index.ts, except
 *   these routers also have admin writes, so the guard stays for writes.
 *
 * - `writeLevel` — override the level required for POST/PATCH/PUT/DELETE
 *   (default 'edit'). Used as `'view'` for scan-so / scan-payment / slips:
 *   their POSTs (warm, enqueue, extract, slip-upload init/confirm) only stage
 *   uploads and background OCR that produce the CALLER's own draft (the
 *   pipeline stamps the caller's staff uuid — PR #245); they never mutate an
 *   existing SO. Actual SO create/edit (mfg-sales-orders) keeps 'edit'.
 *
 * - `openReadPaths` — the SAME escape hatch as `openRead`, but scoped to named
 *   sub-paths instead of the whole router. Needed where a router mixes one
 *   harmless REFERENCE read with genuinely sensitive ones: `/inventory/*` serves
 *   stock levels, FIFO lots, COGS and valuation, so `openRead` on it would be a
 *   real leak — but `GET /inventory/warehouses` is a bare picklist (id / code /
 *   name / location / is_active / is_default, no cost, no quantities) that the SO
 *   and PO forms' Ship-to + Purchase Location dropdowns, and the SO Maintenance
 *   state→warehouse mapping, cannot render without. Listing that ONE path keeps
 *   the rest of the Inventory API gated exactly as before.
 *
 *   Matched as a suffix of `c.req.path`, because the guard runs under the
 *   `/api/scm` mount and does not know its own prefix. Entries are absolute
 *   under that mount (e.g. `/inventory/warehouses`); GET/HEAD only, writes are
 *   never opened.
 *
 * - `readInheritsFrom` — a SECOND area key whose `view` grant ALSO satisfies a
 *   GET/HEAD on this area (writes still require `edit` on the NATIVE area).
 *   Used so a salesperson (scm.sales.orders = view) can READ Delivery Orders +
 *   Sales Invoices generated from their OWN Sales Orders even without a
 *   scm.sales.delivery / scm.sales.invoices grant — the DO/SI routes already
 *   row-scope every read to own+downline (lib/salesScope) and strip cost/margin
 *   from non-finance callers (canViewScmFinance), so this opens NO office/finance
 *   data. Reads only; a salesperson still cannot create/edit a DO/SI.
 */
export interface ScmAreaGuardOpts {
  openRead?: boolean;
  openReadPaths?: readonly string[];
  writeLevel?: AccessLevel;
  readInheritsFrom?: string;
  /**
   * A narrow WRITE escape hatch keyed on something the area level cannot
   * express — a per-position operational CAPABILITY. When it returns true the
   * write is admitted WITHOUT the area level, and the guard sets
   * `scmWriteBypassed=true` so the handler knows this caller got in on a
   * capability (not real area access) and must enforce the capability's exact
   * verb itself. Runs AFTER the JD / money / wildcard rules, so it can never
   * widen past a code rule; keep the predicate as tight as the verb it admits
   * (e.g. only `PATCH …/status` for a caller holding scm.do.load|dispatch).
   * Reads are unaffected.
   */
  writeBypass?: (c: Context<{ Bindings: Env; Variables: Variables }>) => boolean;
}

export function scmAreaGuard(area: string, opts?: ScmAreaGuardOpts): MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> {
  return async (c, next) => {
    // c.get('user') is still the Houzs AuthUser at this point (supabaseAuth has
    // not run yet — see ordering note above).
    const user = c.get("user") as unknown as AuthUser | undefined;
    if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);

    // 1) Owner / wildcard bypasses the L2 gate entirely.
    if (user.permissions_set?.has("*") || user.permissions?.includes("*")) {
      await next();
      return;
    }

    // 1.5) The Sales JD's DENY half — a RULE in code, not a matrix cell, so it
    //      is enforced BEFORE the no-lockout fallthrough below. Without this the
    //      deny was theatre: a Sales rep has no explicit `scm*` row, so step 3
    //      let them straight through to the Delivery Returns API while only the
    //      nav entry (`hideForSales`) and the route guard hid it — and a hidden
    //      nav entry is not a gate, the URL still returned real data.
    //      Deliberately ABOVE `openRead` too: "那些none的直接不給看" is a rule
    //      about the area, not about the method. Inert for every area the JD does
    //      not deny, and `*` is exempt inside salesJdDenial.
    const jdDenial = salesJdDenial(user, area);
    if (jdDenial) return c.json({ error: jdDenial }, 403);

    // 1.55) The Sales JD's WRITE-CAP half — same rule, same map, same reason it
    //       cannot wait for the L2 rollout. SALES_JD caps scm.sales.delivery and
    //       scm.sales.invoices at `view` (owner 2026-07-17: "后面的人是来操作 DO 和
    //       SI 的。销售人员不可能去操作 DO 和 SI，所以他们通常只是来看而已"), but
    //       that cap only bit for a caller who happened to be scm_l2_configured.
    //       A Sales-DEPARTMENT user with no position_id hydrates from the legacy
    //       role matrix, is NOT L2-configured, and step 3 below handed them POST
    //       /delivery-orders-mfg and POST /sales-invoices with the written `view`
    //       sitting inert in their map — the identical trap the returns deny was
    //       written to end. Enforced here for the whole cohort; READS untouched
    //       (method-checked inside), so view + Print PDF survive.
    const jdWriteDenial = salesJdWriteDenial(user, area, c.req.method);
    if (jdWriteDenial) return c.json({ error: jdWriteDenial }, 403);

    // 1.6) The MONEY-MOVING WRITE rule (owner 2026-07-18) — also a RULE in code,
    //      so it is likewise enforced BEFORE the no-lockout fallthrough. His
    //      default-full ruling is about SEEING ("暂时都可以看到系统里的所有内容");
    //      posting a journal entry or a payment voucher is DOING, and stays with
    //      Finance. It has to sit here rather than rely on the `view` written into
    //      page_access: a full position is deliberately NOT scm_l2_configured, so
    //      step 3 below would hand it straight through to the accounting API —
    //      and routes/accounting.ts has no permission gate of its own, making this
    //      guard the only thing between a full position and the GL.
    //      READS ARE UNTOUCHED (the predicate checks the method first) and only
    //      the two finance areas are in scope, so nothing else can be narrowed.
    const moneyDenial = moneyWriteDenial(user, area, c.req.method);
    if (moneyDenial) return c.json({ error: moneyDenial }, 403);

    // 3) No explicit SCM L2 config → fall back to the coarse scm.access umbrella
    //    (already enforced upstream). Never lock out a current scm.access holder.
    if (!user.scm_l2_configured) {
      await next();
      return;
    }

    const write = isWrite(c.req.method);

    // Reference reads open to every caller who passed the coarse umbrella —
    // see ScmAreaGuardOpts above. Reads only; writes fall through to the check.
    if (!write && opts?.openRead) {
      await next();
      return;
    }

    // Same hatch, narrowed to named sub-paths — see ScmAreaGuardOpts above.
    if (!write && opts?.openReadPaths?.some((p) => c.req.path.endsWith(p))) {
      await next();
      return;
    }

    // Capability write-bypass — a caller who lacks the area level but holds the
    // operational capability the handler will enforce (e.g. a storekeeper's
    // scan-to-LOADED on scm.do.load). Flagged so the handler knows to enforce
    // the exact verb; it runs after the JD/money/wildcard rules above, so it
    // never widens past a code rule.
    if (write && opts?.writeBypass?.(c)) {
      c.set("scmWriteBypassed", true);
      await next();
      return;
    }

    // 2) Explicit SCM L2 config → enforce per-area, per-method.
    const requiredLevel: AccessLevel = write ? (opts?.writeLevel ?? "edit") : "view";
    const level: AccessLevel = (user.page_access?.[area] ?? "none") as AccessLevel;
    if (!meetsLevel(level, requiredLevel)) {
      // Read-inherit hatch — a GET/HEAD may be satisfied by `view` on a second
      // area (e.g. a salesperson reading their own SO's Delivery Orders / Sales
      // Invoices via scm.sales.orders). Writes never inherit.
      if (!write && opts?.readInheritsFrom) {
        const inherited = (user.page_access?.[opts.readInheritsFrom] ?? "none") as AccessLevel;
        if (meetsLevel(inherited, "view")) {
          await next();
          return;
        }
      }
      return c.json(
        { error: `Forbidden: needs ${requiredLevel} access to ${area}` },
        403,
      );
    }
    await next();
  };
}
