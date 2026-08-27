import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import type { Env, Variables } from "../env";
import { getSupabaseService } from "../../db/supabase";

// Auth bridge for the ported 2990's SCM routes.
//
// 2990's original `supabaseAuth` validated a Supabase Auth JWT and built a
// per-user RLS client. In Houzs the request is ALREADY authenticated by the
// global /api/* middleware (Houzs session auth, mounted in index.ts), so this
// just attaches the scm-scoped service-role supabase-js client the route
// handlers expect via `c.get('supabase')`. Same export name, so the ported
// route's `import { supabaseAuth } from '../middleware/auth'` is unchanged.
// The ported 2990's routes stamp `created_by` (uuid, FK -> scm.staff) and look up
// the caller's `staff.role` by `user.id` (also a scm.staff uuid). Houzs users are
// INTEGERS, so passing the raw Houzs id makes Postgres reject "1" as a uuid
// ("invalid input syntax for type uuid"). We therefore pin `user` to ONE seeded
// super_admin system staff row — a valid uuid identity that satisfies the FK +
// role lookups. Seed it with backend/scripts/scm-schema/seed-scm-staff.mjs.
//
// THE PIN IS A TYPE SHIM, NOT AN AUTHORIZATION OR IDENTITY STATEMENT. Two claims
// that used to sit here were false, and each one manufactured a bug:
//   · "every caller here is an admin (/api/scm/* is owner-gated)" — NOT TRUE.
//     src/index.ts:250 gates the tree with requireScmAccess, which also admits any
//     position granted a scm* page-access area, and scm/middleware/area-guard.ts
//     admits scoped salespeople per area. Ordinary users reach these routes.
//     So NEVER gate on `user` or staff.role — the pinned row reports super_admin
//     for everybody. Gate on the REAL caller via lib/houzs-perms (hasHouzsPerm /
//     canViewAllSales / canViewScmFinance).
//   · "per-user attribution would need a Houzs-user -> scm.staff sync — a later
//     enhancement" — THAT BRIDGE IS BUILT. Migration 0066 gives every non-disabled
//     user a deterministic staff row (md5('houzs-user:'||id)::uuid) linked by
//     staff.user_id. Resolve the caller's REAL staff uuid with
//     resolveCallerStaffId(sb, c.get('houzsUser')?.id) (lib/salesScope.ts), and
//     their row scope with resolveSalesScopeIds / salesDocOutOfScope.
// Trusting the first claim shipped the pos-cart leak (#633): the cart keyed on
// c.get('user').id, so every salesperson shared ONE row. Anything per-person —
// attribution, ownership, a cart, a visibility scope — reads `houzsUser` and the
// 0066 bridge, never the pinned `user`.
/* EXPORTED since 2026-08-26. The public delivery-order scan has no session, so
   it cannot go through this middleware — but it DOES go through the same status
   writer, which stamps `user.id` onto the inventory movements it produces. That
   caller identity has to be a real, declared one rather than a uuid typed a
   second time in the public route: it is the SAME pinned system-staff row every
   authenticated SCM write already carries, so a scanned movement and an office
   movement are attributed identically and neither is a fabricated person. */
export const SCM_SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";

export const supabaseAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    /* RUN ONCE PER REQUEST. This middleware can be reached TWICE on one request:
       two routers are mounted at the SAME `/mfg-sales-orders` prefix
       (scm/index.ts — the deferred list-enrichment router, then the main SO
       router) and each declares its own `use('*', supabaseAuth)`. Hono runs the
       first mount's middleware, finds no handler for the path there, then falls
       through to the second mount and runs this again.

       A second pass re-read `user` — which the first pass had ALREADY REPLACED
       with the pinned scm.staff uuid below — so `Number(SCM_SYSTEM_STAFF_ID)`
       produced NaN and `houzsUser` came back with no usable id and no
       permissions. That emptied the Sales Orders list for EVERY caller in BOTH
       companies (2026-08-18): canViewAllSales went false and
       resolveSalesScopeIds fail-closed to the match-nothing staff uuid, so the
       list read carried `salesperson_id=in.(00000000-0000-0000-0000-000000000000)`
       and matched nothing. Enforce the once-per-request invariant HERE rather
       than relying on no prefix ever being double-mounted again — the bridge is
       idempotent by nature, and a second pass has nothing left to translate. */
    if ((c.get("user") as { id?: unknown } | undefined)?.id === SCM_SYSTEM_STAFF_ID) {
      return next();
    }
    // Adapt the Houzs session user (set by the global /api/* auth) into the
    // Supabase-User shape the ported routes read. user.id is the scm.staff uuid
    // (system staff); email stays the real Houzs user's for display.
    const hu = c.get("user") as unknown as {
      id?: number | string;
      email?: string;
      name?: string | null;
      position_name?: string | null;
      department_name?: string | null;
      permissions?: string[];
      permissions_set?: Set<string>;
      position_capabilities?: string[];
    } | undefined;
    // Stash the real Houzs user (integer id) for per-user PUBLIC-schema lookups
    // (the next line overwrites `user` with the scm.staff system identity).
    // Mirror permissions / permissions_set so route handlers can gate on flat
    // permission keys against the REAL caller (vs scm.staff.role which is the
    // pinned super_admin system row for every SCM call).
    c.set(
      "houzsUser",
      hu && hu.id != null
        ? {
            id: Number(hu.id),
            email: hu.email,
            name: hu.name ?? null,
            // STABLE ORG FIELDS carried through for pmsAccess.isDirectorUser /
            // isSalesUser (Sales-Director view-all bypass + salesperson
            // amendment self-service — see lib/houzs-perms.ts).
            position_name: hu.position_name ?? null,
            department_name: hu.department_name ?? null,
            permissions: hu.permissions,
            permissions_set: hu.permissions_set,
            // Operational-capability grants (position_capabilities, mig 0322)
            // carried through so SCM handlers can gate on them against the REAL
            // caller — e.g. the DO status endpoint admits a storekeeper's
            // scan-to-LOADED on scm.do.load. hasPositionCapability fails closed
            // when this is absent, so an older cached session simply can't.
            position_capabilities: hu.position_capabilities,
          }
        : undefined,
    );
    c.set("user", {
      id: SCM_SYSTEM_STAFF_ID,
      email: hu?.email ?? "",
      app_metadata: {},
      /* Audit-trail attribution — the SO History timeline (mfg_so_audit_log)
         snapshots `user.user_metadata.name` as the actor. Before this carried
         the REAL caller's name, every entry fell back to the seeded system
         staff row's name, so the timeline could not answer "WHO edited this"
         (the exact dispute the History feature exists to settle). user.id
         stays the pinned system staff uuid — role lookups / created_by FKs
         are unchanged; only the display-name snapshot is personalised. */
      user_metadata: { name: hu?.name ?? hu?.email ?? undefined },
      aud: "authenticated",
      created_at: "",
    } as unknown as User);
    c.set("supabase", getSupabaseService(c.env));
    await next();
  },
);
