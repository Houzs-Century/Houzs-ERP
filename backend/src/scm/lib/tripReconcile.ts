
import { advanceSoGeneration } from './so-generation';
import { recordSoAudit } from './so-audit';

function dual<T = unknown>(row: Record<string, unknown>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return (row[camel] ?? row[snake]) as T;
}

function errMsg(e: unknown): string {
  return String((e as { message?: string })?.message ?? e).slice(0, 140);
}

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
  stopType?: string | null;
};

export type TripReconcile =
  | { state: 'RECONCILED'; clearedDo: number; clearedSo: number }
  | { state: 'NOT_REQUESTED' }
  | { state: 'FAILED'; reason: string };

/** Which overrides a removed stop clears. A Pending Schedule stamp is KEPT: an
 *  order that reached Pending Schedule stays there (lib/pending-schedule-stays.ts). */
export function overrideToClear(state: string | null): boolean {
  return state !== null && state !== 'PENDING_SCHEDULE';
}

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
    const { data: doRowsRaw, error: doReadErr } = await sb.from('delivery_orders')
      .select('id, so_doc_no, delivery_state').in('id', doIds);
    if (doReadErr) {
      return { state: 'FAILED', reason: `could not read the delivery orders to reconcile: ${errMsg(doReadErr)}` };
    }
    const doRows = (doRowsRaw ?? []) as Array<Record<string, unknown>>;

    const doIdsWithOverride = doRows
      .filter((r) => overrideToClear(dual<string | null>(r, 'delivery_state') ?? null))
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
        if (overrideToClear(state)) {
          const docNo = String(dual<string>(r, 'doc_no'));
          soWithOverride.push(docNo);
          prevByDoc.set(docNo, state);
        }
      }
      for (const docNo of soWithOverride) {
        const gen = await advanceSoGeneration(sb, docNo, { delivery_state: null });
        if (!gen.applied) {
          return {
            state: 'FAILED',
            reason: `the sales order ${docNo} was being edited (${gen.reason}); its scheduled override was left in place and may still hide it from Pending Schedule`,
          };
        }
        clearedSo += 1;
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
