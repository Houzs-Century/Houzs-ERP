// ─────────────────────────────────────────────────────────────────────────
// deliveryScope.ts — per-assignee row visibility for the Delivery / TMS module.
//
// THE GAP THIS CLOSES (owner rule, Lim Wei Siang): a Driver / Helper may see
// ONLY the delivery jobs assigned to THEIR OWN name (plus their own history),
// and may act (POD / step submit) ONLY on a job they are assigned to. PR #747
// gave Driver/Helper page-level VIEW of the Delivery Planning board
// (scm.transportation.drivers = view) but NO row scope — so a Driver currently
// sees EVERY job on the board, not just their own. This module is the row scope.
//
// TWO SIGNALS, BOTH MUST AGREE BEFORE WE NARROW A CALLER — the conservative,
// no-lockout, no-ops-regression design the go-live charter demands:
//
//   1. INTENT — resolvePositionPolicy (services/positionPolicy.ts, THE one
//      position policy) must classify the caller into the `restricted` cohort
//      (Driver / Helper / Storekeeper / Storekeeper Supervisor — the positions
//      whose page access is confined to the transportation view). We key on the
//      policy's cohort, NOT a raw position_name regex, so a position rename can
//      never silently inject or drop a restriction (the rename hazard the policy
//      itself documents). Anyone the policy leaves at `full`/`sales` — every
//      dispatcher / ops / office / management / sales caller — is UNSCOPED and
//      keeps the whole board, exactly as today.
//
//   2. IDENTITY — the caller must resolve to at least one scm.drivers or
//      scm.helpers row via the `user_id` link (the internal-staff → fleet-row
//      sync: a Driver position upserts scm.drivers.user_id, a Helper/Storekeeper
//      position upserts scm.helpers.user_id). Those linked ids ARE the scope: a
//      job is theirs when its assigned driver/helper id is in this set.
//
// WHY BOTH, AND WHY FAIL OPEN WHEN THEY DISAGREE. The overriding safety rule is
// "must NOT lock a Driver out of their OWN jobs, and must NOT reduce anything
// for full/ops/dispatcher". So:
//   · policy says full but a stray fleet row exists (an ops person once entered
//     as a driver) → NOT scoped → sees all. Ops is never narrowed by accident.
//   · policy says restricted but no fleet link resolves → the answer SPLITS by
//     whether the caller is FLEET personnel:
//       - Driver / Helper (isFleetPosition) FAIL CLOSED to an EMPTY self scope —
//         an unlinked driver sees an empty board, never the whole fleet's jobs
//         (owner: 只能看到分配给自己的). Fixing the link is an admin action, not
//         a reason to expose everyone.
//       - Storekeeper / Storekeeper Supervisor (restricted but NOT fleet) keep
//         the whole board — it is a coordination surface for them, not a run
//         sheet, so nothing narrows for them.
//     A LOOKUP ERROR (transient, or the link column absent in a bare test DB)
//     still fails OPEN for everyone — a DB fault is not a "you are unlinked"
//     fact and must never lock a driver out mid-shift.
// The result: a linked Driver/Helper sees their own jobs; an UNLINKED one sees
// nothing; every non-fleet caller and every transient failure resolves to the
// whole-board view. In production the sync guarantees the link.
//
// UNASSIGNED JOBS. A board row / trip with no driver+helper assigned is NOT any
// one driver's job. A scoped caller does not see it (empty assignment never
// matches a self scope); ops/dispatcher, being unscoped, still do. That matches
// the owner ruling "a random driver no; ops/dispatcher yes".
// ─────────────────────────────────────────────────────────────────────────

import { resolvePositionPolicy, isFleetPosition } from "../../services/positionPolicy";

/** The caller shape this module reads — a subset of the SCM `houzsUser`
 *  (env.ts Variables.houzsUser): the real Houzs integer user id plus the org +
 *  permission fields positionPolicy / the wildcard check need. Tolerant so the
 *  bridge's houzsUser satisfies it without a cast. */
export interface DeliveryScopeCaller {
  id?: number | null;
  position_name?: string | null;
  department_name?: string | null;
  permissions?: ReadonlyArray<string> | ReadonlySet<string>;
  permissions_set?: ReadonlySet<string>;
}

/** The resolved visibility. `all` = no restriction (the whole board, unchanged).
 *  `self` = only jobs whose assigned driver id ∈ driverIds OR helper id ∈
 *  helperIds. */
export type DeliveryScope =
  | { readonly mode: "all" }
  | {
      readonly mode: "self";
      readonly driverIds: ReadonlySet<string>;
      readonly helperIds: ReadonlySet<string>;
    };

const SCOPE_ALL: DeliveryScope = { mode: "all" };

/** A job's assigned crew, as raw ids (nulls tolerated — an empty/absent id never
 *  matches). SO/board rows source these from the DO header + delivery_order_crew;
 *  trips from trips.driver_id / helper_1_id / helper_2_id. */
export interface CrewAssignment {
  readonly driverIds: ReadonlyArray<string | null | undefined>;
  readonly helperIds: ReadonlyArray<string | null | undefined>;
}

function hasWildcard(caller: DeliveryScopeCaller): boolean {
  if (caller.permissions_set?.has("*")) return true;
  const p = caller.permissions;
  if (!p) return false;
  return Array.isArray(p) ? p.includes("*") : (p as ReadonlySet<string>).has("*");
}

/**
 * Resolve a caller's delivery-board row scope. `all` for every unscoped caller
 * (wildcard, or any position the policy does not confine to the transportation
 * view, or a restricted caller with no resolvable fleet identity — see the
 * fail-open rationale in the file header); `self` with the caller's linked
 * driver + helper ids otherwise.
 *
 * `sb` is the scm-scoped PostgREST client (c.get('supabase')); the driver/helper
 * lookups run against scm.drivers / scm.helpers by their user_id link. A lookup
 * error is swallowed to `all` (fail open — never a lockout, never a 500 on a DB
 * that predates the link column).
 */
export async function resolveDeliveryScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  caller: DeliveryScopeCaller | null | undefined,
): Promise<DeliveryScope> {
  if (!caller) return SCOPE_ALL;
  // The owner / IT wildcard is never narrowed.
  if (hasWildcard(caller)) return SCOPE_ALL;

  // INTENT gate — only the policy's restricted cohort (the transportation-view
  // positions) is a candidate for scoping. Everyone else keeps the whole board.
  const policy = resolvePositionPolicy({
    position_name: caller.position_name ?? null,
    department_name: caller.department_name ?? null,
  });
  if (policy.cohort !== "restricted") return SCOPE_ALL;

  const uid = caller.id;
  if (uid == null || !Number.isFinite(Number(uid))) return SCOPE_ALL;

  // IDENTITY gate — resolve the caller's fleet rows by the user_id link. Any
  // failure (missing column, transient error) fails OPEN to the whole board.
  const driverIds = new Set<string>();
  const helperIds = new Set<string>();
  try {
    const [d, h] = await Promise.all([
      sb.from("drivers").select("id").eq("user_id", Number(uid)),
      sb.from("helpers").select("id").eq("user_id", Number(uid)),
    ]);
    if (d?.error || h?.error) return SCOPE_ALL;
    for (const r of (d?.data ?? []) as Array<{ id?: string }>) if (r.id) driverIds.add(String(r.id));
    for (const r of (h?.data ?? []) as Array<{ id?: string }>) if (r.id) helperIds.add(String(r.id));
  } catch (e) {
    console.log(
      `[deliveryScope] fleet link lookup failed for user=${uid}: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
    );
    return SCOPE_ALL;
  }

  // A restricted caller with NO fleet identity: FLEET personnel (Driver/Helper)
  // fail CLOSED to an empty self scope — an empty self matches no assignment, so
  // an unlinked driver sees nothing rather than the whole fleet (owner: 只能看
  // 到分配给自己的). A restricted NON-fleet caller (Storekeeper / Supervisor)
  // keeps the whole board. A transient lookup error already returned SCOPE_ALL
  // above, so this branch is only the clean "no rows" case.
  if (driverIds.size === 0 && helperIds.size === 0) {
    return isFleetPosition(caller.position_name ?? null)
      ? { mode: "self", driverIds, helperIds }
      : SCOPE_ALL;
  }

  return { mode: "self", driverIds, helperIds };
}

/**
 * Is a job (with the given crew) visible to / actionable by this scope? `all`
 * matches everything; `self` matches iff the job carries at least one of the
 * caller's driver or helper ids. An empty assignment (unassigned job) never
 * matches a `self` scope.
 */
export function scopeMatchesAssignment(
  scope: DeliveryScope,
  assignment: CrewAssignment,
): boolean {
  if (scope.mode === "all") return true;
  for (const d of assignment.driverIds) if (d && scope.driverIds.has(String(d))) return true;
  for (const h of assignment.helperIds) if (h && scope.helperIds.has(String(h))) return true;
  return false;
}
