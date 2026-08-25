import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Env as HouzsEnv } from "../types";

// The ported 2990's SCM routes import { Env, Variables } from '../env'. Re-export
// Houzs's Env, and define the Hono context vars those routes read.
export type Env = HouzsEnv;

export interface Variables {
  // The ported routes read user.id / user.email etc. (originally a Supabase
  // auth user). middleware/auth.ts adapts Houzs's session user into this shape.
  user: User;
  // scm-scoped supabase-js client (service-role), attached by middleware/auth.
  supabase: SupabaseClient<any, any, any>;
  // The REAL Houzs session user (integer id), stashed by middleware/auth BEFORE
  // `user` is overwritten with the scm.staff system identity. It is the ONLY
  // per-person identity inside /api/scm/* — `user.id` is the pinned system staff
  // uuid, shared by every caller. Use it for PUBLIC-schema lookups (e.g. the
  // salesperson's active exhibition project) AND as the input to the scm.staff
  // identity bridge, which is BUILT: migration 0066 links every non-disabled user
  // to a deterministic staff row via staff.user_id, read by
  // resolveCallerStaffId / resolveSalesScopeIds (scm/lib/salesScope.ts).
  // `permissions` / `permissions_set` are mirrored from the AuthUser so SCM
  // route handlers can gate on flat-key permissions (e.g. scm.config.write)
  // against the REAL caller — never against scm.staff.role which the bridge
  // hardcodes to one super_admin row.
  houzsUser: {
    id: number;
    email?: string;
    /** Real display name from public.users — used for audit-trail actor
     *  snapshots (mfg_so_audit_log.actor_name_snapshot). */
    name?: string | null;
    /** STABLE ORG FIELD (public.users → positions.name) mirrored from the real
     *  AuthUser so SCM handlers can call pmsAccess.isDirectorUser against the
     *  REAL caller. The bridge's pinned scm.staff `user` carries no position, so
     *  the director-position sales view-all bypass (canViewAllSales) reads it
     *  from here. null when the user has no position assigned. */
    position_name?: string | null;
    /** STABLE ORG FIELD (public.users → departments.name) mirrored from the real
     *  AuthUser so SCM handlers can call pmsAccess.isSalesUser against the REAL
     *  caller — isSalesUser matches a "Sales …" position OR a department whose
     *  name contains "sales", so both org fields must be carried through.
     *  null when the user has no department assigned. */
    department_name?: string | null;
    permissions?: string[];
    permissions_set?: Set<string>;
    /** Operational-capability grants (position_capabilities, mig 0322) mirrored
     *  from the AuthUser so SCM handlers can gate a verb on the REAL caller —
     *  e.g. the DO status endpoint admits scan-to-LOADED on scm.do.load. */
    position_capabilities?: string[];
  } | undefined;
  /** Set true by scmAreaGuard when a WRITE was admitted via its capability
   *  writeBypass (the caller lacks the area level but holds an operational
   *  capability). The handler MUST then enforce the exact capability verb —
   *  the guard only proved the caller holds SOME qualifying capability, not
   *  that this specific transition is theirs. Absent/false = normal access. */
  scmWriteBypassed?: boolean;
  // The DOOR this request's session was minted at (mig 0120) — 'pos' when it
  // came from the POS PIN login, undefined otherwise. Set by the GLOBAL
  // middleware/auth (which runs before this sub-app) and, unlike `user`, NOT
  // overwritten by the SCM auth bridge — which is the whole point: it is the
  // only per-REQUEST provenance fact that survives into /api/scm/*, and the
  // only thing here a caller cannot assert about itself. Read by the SO
  // pricing envelope (routes/mfg-sales-orders.ts isPosTabletCaller). Optional:
  // undefined = not-POS, the safe direction on every legacy / non-POS session.
  sessionOrigin?: string;
  // Multi-company context (Phase 0b) — resolved by middleware/companyContext.ts
  // and consumed by scm/lib/companyScope.ts. companyId is the ACTIVE company for
  // this request; allowedCompanyIds is what the caller may see (Phase 0b = all).
  // Optional: undefined pre-migration / on DB cold-start, so the scoping helpers
  // no-op and single-company Houzs keeps working.
  companyId?: number;
  companyCode?: string;
  allowedCompanyIds?: number[];
  companies?: Array<{ id: number; code: string; name: string }>;
}
