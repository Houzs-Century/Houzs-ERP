// ----------------------------------------------------------------------------
// tripReconcile.ts — the REVERSE half of the Board <-> Trips sync.
//
// The FORWARD half lives in delivery-planning.ts: the board's schedule action
// (`PATCH /delivery-planning/:type/:id/schedule` -> scheduleOntoTrip) find-or-
// creates a scm.trips row and appends a DELIVERY scm.trip_stops row keyed on the
// order's do_id / so_id. A coordinator who then moves the order out of the
// "Pending Schedule" queue does so by writing the delivery_state OVERRIDE cache
// on the source header (the board's Status cell / bulk apply -> type='so' ->
// mfg_sales_orders.delivery_state, or type='do' -> delivery_orders.delivery_state).
//
// The REVERSE half — this file — runs when a trip/stop CHANGES on the Trips side
// (a stop removed, a trip cancelled or hard-deleted). Without it, the source
// order keeps its scheduled-looking override and never returns to the board as
// schedulable: the board lies about a job no lorry is carrying any more. The
// reconcile CLEARS that override so the board's LIVE derivation
// (derivePlanningState) resumes and a ready-to-ship order falls back to its
// derived PENDING_SCHEDULE.
//
// WHAT THIS IS NOT. It does NOT touch derivePlanningState (the single shared
// owner of the 4-state rule — board + SO list + delivery agent all read it); it
// reconciles by CLEARING the persisted override the derivation already respects,
// never by changing the derivation. It never writes customer_delivery_date
// (owner rule); it never adds a column to any shared SO-LIST header select (the
// VIEW-TRAP); and it never narrows the caller with resolveDeliveryScope —
// scheduling / reconciling is a ONE-DISPATCHER function (owner ruling
// 2026-07-22), the exact asymmetry `scheduleScopeRuling.test.ts` pins.
//
// REPORT, DON'T REPAIR. Same discipline as scheduleOntoTrip's TripWiring: the
// primary action (the stop/trip change) has already committed by the time the
// reconcile runs, so a reconcile that partially fails is REPORTED (state
// FAILED + reason) rather than thrown or silently swallowed — a stale override
// that could not be cleared is named, never hidden behind an ok:true.
// ----------------------------------------------------------------------------

import { advanceSoGeneration } from './so-generation';
import { recordSoAudit } from './so-audit';

/* Dual-read a camelCased OR snake_cased result column. The pg driver camelCases
   result columns; reading the snake_case key alone returns undefined (the #1
   recurring 2990/Houzs bug). Always read both. */
function dual<T = unknown>(row: Record<string, unknown>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return (row[camel] ?? row[snake]) as T;
}

function errMsg(e: unknown): string {
  return String((e as { message?: string })?.message ?? e).slice(0, 140);
}

/* WHICH SOURCE ORDER a removed / cancelled DELIVERY stop belongs to — made pure
   so it can be asserted without a database, exactly like staleStopSweepFor (its
   forward twin). The two are deliberately symmetric: the forward sweep keys a
   re-schedule's stale-stop DELETE on do_id (falling back to so_id); the reverse
   keys the override CLEAR on the same column the stop was written by.

   The NO_SOURCE arm is load-bearing, not defensive filler:
     - so_id is never populated for an SO/DO delivery. scm.mfg_sales_orders has a
       TEXT PK (doc_no) and NO uuid `id`, so nothing can be written into
       trip_stops.so_id; a board-scheduled SO reaches its trip through its DO and
       the stop carries do_id. A so_id-only stop therefore cannot be mapped back
       to a header, and the SO override (if any) is reached via the DO's
       so_doc_no during the async reconcile, not from so_id.
     - a stop with neither uuid is an ASSR leg (keyed on assr_case_id, mig 0166)
       or a manual DP job (dp-orders.ts, all three NULL). Neither is an SO/DO
       delivery this path owns; ASSR reconcile is a different key writing to
       public.assr_cases and is deliberately out of scope here. */
export type StopReconcileKey =
  | { state: 'RECONCILE'; doId: string }
  | { state: 'NO_SOURCE'; reason: string };

export function stopReconcileKeyFor(
  doId: string | null | undefined,
  soId: string | null | undefined,
): StopReconcileKey {
  if (doId) return { state: 'RECONCILE', doId };
  if (soId) {
    return {
      state: 'NO_SOURCE',
      reason:
        'the stop carries only so_id; scm.mfg_sales_orders has no uuid id, so an SO is reconciled through its DO (do_id) — a so_id-only stop cannot be mapped to a header',
    };
  }
  return {
    state: 'NO_SOURCE',
    reason:
      'the stop carries no do_id (an ASSR leg keys on assr_case_id; a manual DP job carries all three NULL) — not an SO/DO delivery to reconcile',
  };
}

export type ReconcileStop = {
  doId: string | null | undefined;
  soId: string | null | undefined;
  /* Only DELIVERY stops are the SO/DO delivery this path owns — the caller
     filters, but the type carries it for clarity. */
  stopType?: string | null;
};

/* THREE STATES, never two — the same collapse-avoidance as TripWiring. RECONCILED
   (the overrides that were set have been cleared, possibly zero), NOT_REQUESTED
   (no stop mapped to a source order at all), FAILED (something could not be
   cleared and the board may still show a stale scheduled order). */
export type TripReconcile =
  | { state: 'RECONCILED'; clearedDo: number; clearedSo: number }
  | { state: 'NOT_REQUESTED' }
  | { state: 'FAILED'; reason: string };

/**
 * Clear the scheduled-looking delivery_state override on the source order(s) of
 * the given DELIVERY stops, so the board's live derivation returns them to
 * PENDING_SCHEDULE. Best-effort + REPORTED (the stop/trip change already
 * committed). A no-op when no stop maps to a source order, and — crucially — a
 * no-op when the source header carries NO override (the common case: assigning a
 * lorry never writes one), so a routine stop removal does not churn the SO
 * generation or spam the audit log.
 */
export async function reconcileStopsToBoard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  opts: { stops: ReconcileStop[]; actorId?: string | null; actorName?: string | null },
): Promise<TripReconcile> {
  const doIds = Array.from(
    new Set(
      opts.stops
        .map((s) => stopReconcileKeyFor(s.doId ?? null, s.soId ?? null))
        .filter((k): k is Extract<StopReconcileKey, { state: 'RECONCILE' }> => k.state === 'RECONCILE')
        .map((k) => k.doId),
    ),
  );
  if (doIds.length === 0) return { state: 'NOT_REQUESTED' };

  try {
    /* 1. Resolve each DO's parent SO + its current override. */
    const { data: doRowsRaw, error: doReadErr } = await sb.from('delivery_orders')
      .select('id, so_doc_no, delivery_state').in('id', doIds);
    if (doReadErr) {
      return { state: 'FAILED', reason: `could not read the delivery orders to reconcile: ${errMsg(doReadErr)}` };
    }
    const doRows = (doRowsRaw ?? []) as Array<Record<string, unknown>>;

    /* 2. Clear the DO-header override cache — ONLY where it is actually set.
          delivery_orders has no generation guard, so a plain update mirrors the
          forward type='do' schedule path exactly. */
    const doIdsWithOverride = doRows
      .filter((r) => (dual<string | null>(r, 'delivery_state') ?? null) !== null)
      .map((r) => String(dual<string>(r, 'id')));
    let clearedDo = 0;
    if (doIdsWithOverride.length > 0) {
      const { error } = await sb.from('delivery_orders')
        .update({ delivery_state: null, updated_at: new Date().toISOString() })
        .in('id', doIdsWithOverride);
      if (error) {
        return {
          state: 'FAILED',
          reason: `the delivery order override could not be cleared — the order may still look scheduled on the board: ${errMsg(error)}`,
        };
      }
      clearedDo = doIdsWithOverride.length;
    }

    /* 3. Clear the SO-header override cache. The board's schedulable row is the
          SO, and its override lives on mfg_sales_orders — written through the
          CANONICAL generation writer (advanceSoGeneration), NOT a raw update, so
          a human holding the SO's edit lease is not clobbered (the note-wipe bug
          class, BUG-HISTORY). Only SOs that actually carry an override are
          touched, so a routine removal churns no version and writes no audit. */
    const prevByDoc = new Map<string, string | null>();
    const soDocNos = Array.from(
      new Set(
        doRows
          .map((r) => (dual<string | null>(r, 'so_doc_no') ?? null))
          .filter((x): x is string => !!x),
      ),
    );
    let clearedSo = 0;
    if (soDocNos.length > 0) {
      const { data: soRowsRaw, error: soReadErr } = await sb.from('mfg_sales_orders')
        .select('doc_no, delivery_state').in('doc_no', soDocNos);
      if (soReadErr) {
        return { state: 'FAILED', reason: `could not read the sales orders to reconcile: ${errMsg(soReadErr)}` };
      }
      const soWithOverride: string[] = [];
      for (const r of (soRowsRaw ?? []) as Array<Record<string, unknown>>) {
        const state = dual<string | null>(r, 'delivery_state') ?? null;
        if (state !== null) {
          const docNo = String(dual<string>(r, 'doc_no'));
          soWithOverride.push(docNo);
          prevByDoc.set(docNo, state);
        }
      }
      for (const docNo of soWithOverride) {
        const gen = await advanceSoGeneration(sb, docNo, { delivery_state: null });
        if (!gen.applied) {
          /* A lease (someone is editing the SO right now) or a version conflict.
             Stand down rather than clobber — but REPORT, because the stop is
             already gone and the board override is stale until the next clear. */
          return {
            state: 'FAILED',
            reason: `the sales order ${docNo} was being edited (${gen.reason}); its scheduled override was left in place and may still hide it from Pending Schedule`,
          };
        }
        clearedSo += 1;
        /* Header mutation gets an audit row (owner requirement) — the same shape
           the forward schedule writes, so the timeline shows override -> cleared. */
        await recordSoAudit(sb, {
          docNo,
          action: 'UPDATE_DETAILS',
          actorId: opts.actorId ?? null,
          actorName: opts.actorName ?? null,
          fieldChanges: [{ field: 'deliveryState', from: prevByDoc.get(docNo) ?? null, to: null }],
          source: 'trips-reconcile',
          note: 'Delivery override cleared — trip/stop removed; order returned to its derived state (Pending Schedule when ready to ship)',
        });
      }
    }

    return { state: 'RECONCILED', clearedDo, clearedSo };
  } catch (e) {
    return { state: 'FAILED', reason: `reconcile failed: ${errMsg(e)}` };
  }
}

/**
 * The wire shape of a trips response's reconcile field. Present ONLY on FAILED —
 * an absent key means the reconcile was not needed or succeeded, exactly the
 * present-only-on-failure convention `tripFieldsFor` uses for tripWiring, so the
 * absence carries one meaning and a stale override is never silent.
 */
export function reconcileFieldsFor(r: TripReconcile): { reconcile?: { failed: true; reason: string } } {
  return r.state === 'FAILED' ? { reconcile: { failed: true, reason: r.reason } } : {};
}
