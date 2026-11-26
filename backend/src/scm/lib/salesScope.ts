
import type { Env } from "../../types";
import { subtreeUserIds } from "../../services/orgScope";
import { chunkIn } from "./paginate-all";

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
  if (canViewAll) return null;
  if (houzsUserId == null || !Number.isFinite(Number(houzsUserId))) {
    return [MATCH_NOTHING_STAFF_ID];
  }
  const userIds = await subtreeUserIds(env, Number(houzsUserId));
  const { data, error } = await sb
    .from("staff")
    .select("id")
    .in("user_id", userIds);
  if (error) {
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
  if (ids === null) return false;
  return salespersonId == null || !ids.includes(String(salespersonId));
}

/* ── SALES ORDERS ONLY: shared orders + open-to-all ─────────────────────────
   Owner 2026-09-09: a Sales Order can be shared with several salespeople, who
   all see and edit it equally ("接手的几位 sales person 都有权限"). Migration
   20260909T1000 added `collaborator_staff_ids` (what was granted) and the
   trigger-maintained `access_staff_ids` (salesperson_id + collaborators), and
   the two helpers below are the ONLY place a scoped SO read should express the
   rule. Everything else on the sales side — DO, SI, delivery returns,
   consignment, quotes, reports, AR reconciliation — deliberately keeps
   `.in('salesperson_id', …)`: those documents snapshot the rep who sold the
   order, which is what commission is booked from. See docs/modules/
   so-handover.md §"Reach".

   Owner 2026-09-11: the same two helpers also honour `open_to_all` (boolean,
   mig 20260911T1500) — an order flagged open is visible to (and, subject to the
   unchanged state locks, editable by) EVERY caller, bypassing access_staff_ids.
   It is visibility only: attribution, commission and the per-person money
   endpoints (/mine, /my-mtd — which scope on the caller's own staff uuid, not
   these helpers) are untouched. See docs/modules/sales-order.md.              */

/**
 * Apply the caller's row-level scope to a query over `mfg_sales_orders` or its
 * payment-totals VIEW. Replaces `.in('salesperson_id', scopeIds)` one-for-one:
 * a null scope is unrestricted, and the match-nothing sentinel still matches
 * nothing (no order carries the all-zeros uuid).
 *
 * `access_staff_ids` is empty for an order with a NULL salesperson_id, so such
 * rows stay invisible to a scoped caller exactly as they are today.
 */
export function applySoScope<T>(q: T, scopeIds: string[] | null): T {
  if (!scopeIds) return q;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout this module.
  return (q as any).or(
    `access_staff_ids.ov.{${scopeIds.join(",")}},open_to_all.is.true`,
  ) as T;
}

/**
 * The single-document form, for SO detail / print / mutation gates that answer
 * 404 rather than 403. Pass the row's `access_staff_ids` — the caller is in
 * scope if ANY of their staff uuids appears in it.
 *
 * `accessStaffIds` absent or empty falls back to the `salespersonId` test, so a
 * gate whose read has not been given the column keeps TODAY's behaviour rather
 * than opening up: a collaborator would be refused, never a stranger admitted.
 *
 * `openToAll` true short-circuits to in-scope for everyone (mig 20260911T1500).
 * A gate whose read has not been given the column passes `undefined`, which is
 * falsy, so it keeps TODAY's behaviour — fail-safe, never fail-open.
 */
export async function soDocOutOfScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout this module (see the four functions around it); typing it here alone would describe a contract the rest of the file does not keep.
  sb: any,
  env: Env,
  houzsUserId: number | null | undefined,
  canViewAll: boolean,
  doc: {
    salespersonId?: number | string | null;
    accessStaffIds?: readonly (string | null)[] | null;
    openToAll?: boolean | null;
  },
): Promise<boolean> {
  if (doc.openToAll) return false;
  const ids = await resolveSalesScopeIds(sb, env, houzsUserId, canViewAll);
  if (ids === null) return false;
  const access = (doc.accessStaffIds ?? []).filter((x): x is string => !!x);
  if (access.length > 0) return !access.some((a) => ids.includes(String(a)));
  return doc.salespersonId == null || !ids.includes(String(doc.salespersonId));
}

/* ── SO amendments + SO cancellation requests: who may SEE a request ─────────
   Owner 2026-10-06 (DEV-40, Nico): 「sales person only see own request, like
   sales order」. A scoped caller sees a request that they or their downline
   RAISED, or one on an order that they or their downline OWN or were SHARED —
   so the order's salesperson always sees what was asked of their order.

   `open_to_all` deliberately does NOT reach these. It opens the ~2,580
   AutoCount-imported orders so anyone can LOOK AN ORDER UP; inherited here it
   put every rep's amendments on every rep's queue (Adrian, a Sales Executive,
   saw all 201). That is why these helpers exist beside applySoScope /
   soDocOutOfScope instead of reusing them.                                    */

export type SoOwnership = {
  salesperson_id?: number | string | null;
  access_staff_ids?: readonly (string | null)[] | null;
};

/** Does the order belong to the scope — owned or shared, never open_to_all.
 *  An empty `access_staff_ids` falls back to `salesperson_id`, the same rule
 *  soDocOutOfScope applies. A missing order belongs to nobody. */
export function soOwnedInScope(scopeIds: readonly string[], so: SoOwnership | null | undefined): boolean {
  if (!so) return false;
  const access = (so.access_staff_ids ?? []).filter((x): x is string => !!x);
  if (access.length > 0) return access.some((a) => scopeIds.includes(String(a)));
  return so.salesperson_id != null && scopeIds.includes(String(so.salesperson_id));
}

/** Ownership columns of the given orders, keyed by doc_no. `inCompany` applies
 *  the caller's company predicate. A failed read is returned, never swallowed:
 *  an empty map would quietly hide a rep's own requests from them. */
export async function readSoOwnership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout this module.
  sb: any,
  docNos: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same untyped builder, passed through companyScope.
  inCompany: (q: any) => any,
): Promise<{ byDoc: Map<string, SoOwnership>; error: string | null }> {
  const byDoc = new Map<string, SoOwnership>();
  if (docNos.length === 0) return { byDoc, error: null };
  const { data, error } = await chunkIn<SoOwnership & { doc_no: string }>([...docNos], (batch, from, to) =>
    inCompany(sb.from("mfg_sales_orders").select("doc_no, salesperson_id, access_staff_ids").in("doc_no", batch))
      .range(from, to));
  if (error) return { byDoc, error: error.message };
  for (const r of data) byDoc.set(r.doc_no, r);
  return { byDoc, error: null };
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
