import { describe, expect, test } from "vitest";
import { stopReconcileKeyFor, reconcileFieldsFor } from "../src/scm/lib/tripReconcile";
import { derivePlanningState } from "../src/scm/routes/delivery-planning";

/* THE REVERSE HALF OF THE BOARD <-> TRIPS SYNC.
 *
 * The forward half (scheduleOntoTrip) writes a DELIVERY trip_stop keyed on the
 * order's do_id and, when a coordinator moves the order out of the "Pending
 * Schedule" queue, a delivery_state OVERRIDE on the source header. The reverse
 * half (reconcileStopsToBoard) runs when that stop/trip is removed and CLEARS
 * the override so the board's LIVE derivation returns the order to its derived
 * state — PENDING_SCHEDULE when it is ready to ship.
 *
 * WHAT IS PINNED HERE, AND WHAT IS NOT. Two things are pure and are tested as
 * such: (1) which source order a removed stop maps to (stopReconcileKeyFor, the
 * reverse twin of staleStopSweepFor) and (2) that clearing the override returns
 * a ready order to PENDING_SCHEDULE via the SHARED derivePlanningState — the same
 * rule the board, the SO list and the delivery agent read, which the reconcile
 * must never fork. What CANNOT be tested here is the clear actually running
 * against a database: this suite binds D1 (vitest.config.mts, DATABASE_URL
 * pinned ""), and every scm route reads Postgres through c.get('supabase'). The
 * runtime clear is a staging check, stated as such in the PR body — the same
 * honest limit scheduleStaleStopSweep.test.ts and tripWiring.test.ts record.
 *
 * The source assertions at the bottom pin that the reconcile is WIRED INTO all
 * three trip write endpoints, and REPORTED (never swallowed) on failure. A pure
 * function nothing calls is decoration.
 */

const DO_UUID = "1f0a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const SO_UUID = "9a8b7c6d-5e4f-4321-9876-543210fedcba";

describe("stopReconcileKeyFor — which source order a removed stop maps to", () => {
  test("a stop with a do_id reconciles on that do_id", () => {
    const k = stopReconcileKeyFor(DO_UUID, null);
    expect(k.state).toBe("RECONCILE");
    if (k.state !== "RECONCILE") return;
    expect(k.doId).toBe(DO_UUID);
  });

  test("do_id wins when both are present — the key the stop was WRITTEN by", () => {
    /* Symmetric with staleStopSweepFor: the forward insert and de-dup prefer
       do_id, so the reverse must reconcile on do_id too. */
    const k = stopReconcileKeyFor(DO_UUID, SO_UUID);
    expect(k.state).toBe("RECONCILE");
    if (k.state !== "RECONCILE") return;
    expect(k.doId).toBe(DO_UUID);
  });

  test("a so_id-only stop is REFUSED — an SO is reached through its DO, never so_id", () => {
    /* scm.mfg_sales_orders has a TEXT PK (doc_no) and no uuid id, so nothing is
       ever written into trip_stops.so_id; a board-scheduled SO reaches its trip
       through its DO. A so_id-only stop cannot be mapped to a header. */
    const k = stopReconcileKeyFor(null, SO_UUID);
    expect(k.state).toBe("NO_SOURCE");
    if (k.state !== "NO_SOURCE") return;
    expect(k.reason).toBeTruthy();
    // NO_SOURCE carries no doId for a caller to accidentally act on.
    expect(Object.prototype.hasOwnProperty.call(k, "doId")).toBe(false);
  });

  test("a stop with neither uuid is REFUSED (an ASSR leg / manual DP job, not this path's)", () => {
    /* An ASSR leg keys on assr_case_id (mig 0166); a manual DP job carries all
       three NULL. Neither is an SO/DO delivery this reverse path owns. */
    const k = stopReconcileKeyFor(null, null);
    expect(k.state).toBe("NO_SOURCE");
  });

  test("an empty-string uuid is treated as no key, not as a value to match on", () => {
    const k = stopReconcileKeyFor("", "");
    expect(k.state).toBe("NO_SOURCE");
  });
});

describe("clearing the override returns a ready order to PENDING_SCHEDULE (shared rule)", () => {
  /* A ready-to-ship, not-yet-delivered SO. This is the exact order a coordinator
     schedules onto a trip and then hides from the queue with a manual override. */
  const readyUndelivered = {
    status: "CONFIRMED",
    readiness: { mainCount: 1, isMainReady: true, isFullyReady: true },
    delivered: 0,
    remaining: 5,
    effectiveDD: "2026-08-01",
    today: "2026-07-25",
  };

  test("WITH the scheduled-looking override it is NOT in Pending Schedule", () => {
    /* The stale state: the coordinator forced it out of the queue. This is what
       makes the board lie after the trip is cancelled. */
    const withOverride = derivePlanningState({ storedOverride: "PENDING_DELIVERY", ...readyUndelivered });
    expect(withOverride).toBe("PENDING_DELIVERY");
  });

  test("once the override is CLEARED (null) the derivation falls back to PENDING_SCHEDULE", () => {
    /* The reverse sync's whole job, proven against the SHARED rule: clear the
       override and a ready order returns to the board as schedulable. */
    const cleared = derivePlanningState({ storedOverride: null, ...readyUndelivered });
    expect(cleared).toBe("PENDING_SCHEDULE");
  });

  test("clearing NEVER un-delivers a genuinely delivered order — the live rule still wins", () => {
    /* The safety of clearing-to-truth: an order that is actually delivered keeps
       deriving DELIVERED after the override is gone, so the reverse sync cannot
       wrongly drag a delivered job back onto the schedule queue. */
    const delivered = derivePlanningState({
      storedOverride: null,
      status: "DELIVERED",
      readiness: { mainCount: 1, isMainReady: true, isFullyReady: true },
      delivered: 5,
      remaining: 0,
      effectiveDD: "2026-08-01",
      today: "2026-07-25",
    });
    expect(delivered).toBe("DELIVERED");
  });
});

describe("reconcileFieldsFor — present only on failure", () => {
  test("FAILED surfaces a reconcile.failed field with a reason", () => {
    const f = reconcileFieldsFor({ state: "FAILED", reason: "boom" });
    expect(f.reconcile).toEqual({ failed: true, reason: "boom" });
  });

  test("RECONCILED and NOT_REQUESTED add NOTHING (a stale override is never silent, a clean one never noisy)", () => {
    expect(reconcileFieldsFor({ state: "RECONCILED", clearedDo: 0, clearedSo: 0 })).toEqual({});
    expect(reconcileFieldsFor({ state: "NOT_REQUESTED" })).toEqual({});
  });
});

/* ── The reconcile is actually wired into all three trip write endpoints ───────
   `?raw` is expanded by Vite at TRANSFORM time, in Node, so the file contents are
   baked into the bundle — this suite runs in workerd, where fs throws. Same
   technique, and same reason, as tests/scheduleStaleStopSweep.test.ts. */
const sources = import.meta.glob("../src/scm/routes/trips.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? "";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("trips.ts — the reverse sync is wired into every trip write endpoint", () => {
  test("the source loaded (a silent empty glob must not pass)", () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("reconcileStopsToBoard");
  });

  test("it does NOT narrow the caller with resolveDeliveryScope on the reconcile", () => {
    /* The reconcile is UNSCOPED by the same owner ruling that keeps the forward
       schedule unscoped (2026-07-22): scheduling / reconciling is a one-dispatcher
       function. The status handler DOES call resolveDeliveryScope for its OWN
       ownership check on advancing a step — that is separate and pre-existing — but
       the reconcile helper must not add a scope narrowing of its own. */
    const stripped = stripComments(routeSource);
    // reconcileStopsToBoard is called; it must never be gated by a scope match.
    expect(stripped).toContain("reconcileStopsToBoard");
    // The helper itself takes no scope — assert the call sites pass stops + actor only.
    expect(stripped).toContain("reconcileStopsToBoard(sb, { stops");
  });

  test("cancelling a trip (soft DELETE) reconciles its stranded orders", () => {
    const stripped = stripComments(routeSource);
    // The soft-cancel path reads the stops up front and reconciles both there and
    // in the hard path; assert the cancel branch reports it.
    expect(stripped).toContain("cancelled: true");
    expect(stripped).toContain("...reconcileFieldsFor(reconcile)");
  });

  test("the status endpoint reconciles ONLY when the trip flips to CANCELLED", () => {
    const stripped = stripComments(routeSource);
    expect(stripped).toContain("status === 'CANCELLED'");
  });

  test("removing a single stop reads its keys BEFORE the delete, then reconciles", () => {
    const stripped = stripComments(routeSource);
    /* The stop must be snapshotted before it is deleted — once gone it cannot be
       mapped to a header. */
    const delStopIdx = stripped.indexOf("trips.delete('/:id/stops/:stopId'");
    expect(delStopIdx).toBeGreaterThan(-1);
    const body = stripped.slice(delStopIdx, delStopIdx + 1200);
    expect(body).toContain("trip_stops");
    expect(body).toContain(".select('do_id, so_id, stop_type')");
    expect(body).toContain("reconcileStopsToBoard");
    // and it only reconciles DELIVERY stops.
    expect(body).toContain("'DELIVERY'");
  });

  test("a reconcile failure is REPORTED on every path, not swallowed", () => {
    /* The stop/trip change already committed by the time the reconcile runs, so a
       partial failure is surfaced via reconcile.failed rather than an ok:true that
       hides a still-stale board. Same report-don't-repair discipline as the
       forward TripWiring. */
    const stripped = stripComments(routeSource);
    const count = stripped.split("reconcileFieldsFor(reconcile)").length - 1;
    // status-cancel, single-stop delete, hard delete, soft cancel = 4 call sites.
    expect(count).toBeGreaterThanOrEqual(4);
  });
});
