
import type { DataQuality } from './governance';
import { dataQualityGate } from './governance';

const STALE_CADENCE_MULTIPLE = 2;

export interface FamilyDataQuality {
  status: DataQuality;
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
