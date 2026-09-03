// ─────────────────────────────────────────────────────────────────────────
// salesScope.ts — row-level "own / downline" visibility for the SCM
// sales-side documents (sales orders, delivery orders, sales invoices,
// consignment orders).
//
// HOUZS VOCABULARY (2026-07 fix — this was the non-admin 500):
//   · The caller identity must be the REAL Houzs user (integer public.users
//     id from c.get('houzsUser')), NOT c.get('user').id — the SCM auth
//     bridge pins user.id to ONE system scm.staff uuid, and feeding that
//     uuid into the old sales_reps integer lookup threw
//     "invalid input syntax for type integer" → 500 for every caller
//     without scm.so.view_all.
//   · The scope this returns is a list of scm.staff UUIDs (matching the
//     `salesperson_id` column stamped from the mig-0066 staff picker), NOT
//     Houzs integer user ids. Integer ids against the uuid column would
//     22P02 the PostgREST filter — the second half of the same 500.
//
// VISIBILITY RULE (owner spec, 2026-07): view-all callers (`*` wildcard or
// `scm.so.view_all`) are unrestricted; everyone else sees SELF + FULL
// REPORTING CHAIN — every user under them in the public.users.manager_id
// tree, any depth (services/orgScope.ts). This supersedes the old
// sales_reps-subtree tier AND the old "non-reps see all" fallback: a
// non-admin caller without view_all is ALWAYS scoped now.
//
// Keep this as the single source of truth so every sales-doc list/detail
// scopes identically.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types";
import { subtreeUserIds } from "../../services/orgScope";

/* An all-zeros uuid no scm.staff row ever carries (the seeded system row is
   …-000000000001). Returned instead of an EMPTY scope list because
   PostgREST rejects an empty `in.()` filter (400 → the routes would 500);
   a one-element impossible id keeps `.in('salesperson_id', scope)` valid
   while matching nothing — fail closed, never open. */
const MATCH_NOTHING_STAFF_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The scm.staff uuids (salesperson_id vocabulary) a caller may see, or
 * null for "no restriction". `canViewAll` is computed by the caller via
 * the Houzs `scm.so.view_all` permission (Owner + IT Admin pass via `*`).
 *
 * `houzsUserId` is the REAL caller's public.users integer id
 * (c.get('houzsUser')?.id) — never the bridge's pinned staff uuid.
 * An absent id (should not happen on an authed request) scopes to
 * nothing rather than everything.
 */
export async function resolveSalesScopeIds(
  sb: any,
  env: Env,
  houzsUserId: number | null | undefined,
  canViewAll: boolean,
): Promise<string[] | null> {
  if (canViewAll) return null; // view-all tier
  if (houzsUserId == null || !Number.isFinite(Number(houzsUserId))) {
    return [MATCH_NOTHING_STAFF_ID];
  }
  // Self + full downline chain (users.manager_id tree, cycle-guarded).
  const userIds = await subtreeUserIds(env, Number(houzsUserId));
  // Map integer user ids → scm.staff uuids via the mig-0066 sync link
  // (staff.user_id). Every non-disabled user has a deterministic staff row
  // (md5('houzs-user:'||id)::uuid) from the 0066 backfill + trigger.
  const { data, error } = await sb
    .from("staff")
    .select("id")
    .in("user_id", userIds);
  if (error) {
    // Fail CLOSED (own/none) — never fail open to the whole book.
    console.log(
      `[salesScope] staff uuid lookup failed for user=${houzsUserId}: ${error.message}`,
    );
    return [MATCH_NOTHING_STAFF_ID];
  }
  const ids = ((data ?? []) as Array<{ id?: string }>)
    .map((r) => r.id)
    .filter((x): x is string => !!x);
  return ids.length > 0 ? ids : [MATCH_NOTHING_STAFF_ID];
}

/**
 * True when a single document's salesperson_id falls OUTSIDE the caller's
 * scope — used by detail/print reads to answer 404 (indistinguishable from a
 * nonexistent doc_no), matching the POS self-scope hatch's behavior.
 */
export async function salesDocOutOfScope(
  sb: any,
  env: Env,
  houzsUserId: number | null | undefined,
  canViewAll: boolean,
  salespersonId: number | string | null | undefined,
): Promise<boolean> {
  const ids = await resolveSalesScopeIds(sb, env, houzsUserId, canViewAll);
  if (ids === null) return false; // unrestricted
  return salespersonId == null || !ids.includes(String(salespersonId));
}

/**
 * The caller's OWN scm.staff uuid (mig 0066 deterministic row, linked by
 * staff.user_id), or null when the sync row is missing. Used for
 * self-attribution (SO create stamp, /mine, /my-mtd) — the bridge's pinned
 * system staff uuid must never be used for per-person attribution.
 */
export async function resolveCallerStaffId(
  sb: any,
  houzsUserId: number | null | undefined,
): Promise<string | null> {
  if (houzsUserId == null || !Number.isFinite(Number(houzsUserId))) return null;
  const { data } = await sb
    .from("staff")
    .select("id")
    .eq("user_id", Number(houzsUserId))
    .maybeSingle();
  return ((data as { id?: string } | null)?.id as string | undefined) ?? null;
}

/**
 * The REVERSE of resolveCallerStaffId: the public.users id behind one scm.staff
 * uuid, or null when there is none — an AutoCount-imported staff row carries no
 * `user_id`, and so does a deleted account.
 *
 * Used to address a NOTIFICATION at the people a document names: its
 * `requested_by` / `salesperson_id` are staff uuids, while the announcements
 * machinery targets integer user ids. Returns null (never throws) on a DB
 * error — every caller is a best-effort notifier, none of them a gate, so a
 * failed lookup must cost a notice and nothing else.
 */
export async function resolveUserIdByStaffId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout this module (see the four functions above); typing it here alone would describe a contract the rest of the file does not keep.
  sb: any,
  staffId: string | null | undefined,
): Promise<number | null> {
  if (!staffId) return null;
  const { data, error } = await sb
    .from("staff")
    .select("user_id")
    .eq("id", staffId)
    .maybeSingle();
  if (error) {
    console.log(`[salesScope] staff -> user lookup failed for ${staffId}: ${error.message}`);
    return null;
  }
  const uid = Number((data as { user_id?: number | string | null } | null)?.user_id);
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}
