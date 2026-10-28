// ---------------------------------------------------------------------------
// data-quality.ts — a REAL Green/Amber/Red signal per agent family.
//
// governance.ts encodes the §10.2 gate (RED must stop a material action), and the
// two self-approval paths call it — but both passed a hard-coded GREEN. That made
// the protection inert: a gate that can never turn red is a comment, not a
// control. This computes the signal from evidence the runtime already records.
//
// The evidence is `agent_runs` — every execution writes one row with a status and
// a timestamp:
//   RED    the family's last run ERRORED (or it has never run at all). Its brief
//          and findings are then either absent or from a run that failed, so
//          anything self-approved on top of them rests on nothing.
//   AMBER  the last run SUCCEEDED but is STALE — older than twice the family's
//          cadence, i.e. it has missed a beat. The numbers are real but old, and
//          §10.2 says an amber may be analysed, not self-executed.
//   GREEN  last run ok and fresh.
//
// Deliberately conservative in one direction only: every uncertainty (no run, an
// unreadable table, an unparseable timestamp) resolves toward RED/AMBER, never
// toward GREEN. A gate that fails open is the same as no gate.
// ---------------------------------------------------------------------------

import type { DataQuality } from './governance';
import { dataQualityGate } from './governance';

/** How many multiples of the cadence may pass before a brief is "stale". Two —
 *  one missed beat is a blip, two is a pattern worth holding autonomy for. */
const STALE_CADENCE_MULTIPLE = 2;

export interface FamilyDataQuality {
  status: DataQuality;
  /** Why — carried into the run summary so a held action explains itself. */
  reason: string;
}

interface RunRow {
  status?: string | null;
  started_at?: string | null;
  startedAt?: string | null;
  error?: string | null;
}

/**
 * The data-quality of one agent family, from its own run history.
 *
 * `task` is the family's task id ('procurement-run'); `cadenceHours` is its
 * minGapHours, i.e. how often it is supposed to run.
 *
 * Never throws: an unreadable agent_runs table is itself a RED signal (we cannot
 * evidence freshness), not a reason to proceed.
 */
export async function familyDataQuality(
  db: D1Database,
  task: string,
  cadenceHours: number,
): Promise<FamilyDataQuality> {
  let row: RunRow | null = null;
  try {
    row = await db
      .prepare(
        `SELECT status, started_at, error FROM agent_runs
          WHERE agent = ? AND status <> 'running'
          ORDER BY started_at DESC LIMIT 1`,
      )
      .bind(task)
      .first<RunRow>();
  } catch (e) {
    const v = dataQualityGate({ missingSource: true });
    return { status: v.status, reason: `could not read the run history (${String((e as Error)?.message ?? e).slice(0, 80)})` };
  }

  if (!row) {
    const v = dataQualityGate({ missingSource: true });
    return { status: v.status, reason: `${task} has never completed a run — there is nothing to act on` };
  }
  if (String(row.status ?? '') === 'error') {
    const v = dataQualityGate({ integrityAlert: true });
    return { status: v.status, reason: `${task}'s last run errored (${String(row.error ?? 'no detail').slice(0, 80)})` };
  }

  const startedAt = row.startedAt ?? row.started_at ?? '';
  const ms = Date.parse(String(startedAt));
  if (!Number.isFinite(ms)) {
    // A run we cannot date cannot be shown to be fresh.
    const v = dataQualityGate({ staleSnapshot: true });
    return { status: v.status, reason: `${task}'s last run has no usable timestamp` };
  }
  const ageHours = (Date.now() - ms) / 3_600_000;
  const limit = Math.max(1, cadenceHours) * STALE_CADENCE_MULTIPLE;
  if (ageHours > limit) {
    const v = dataQualityGate({ staleSnapshot: true });
    return {
      status: v.status,
      reason: `${task}'s last run is ${Math.round(ageHours)}h old (over the ${Math.round(limit)}h freshness budget)`,
    };
  }

  const v = dataQualityGate({});
  return { status: v.status, reason: `${task} ran ${Math.round(ageHours)}h ago and succeeded` };
}
