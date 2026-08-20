import type { Env } from "../types";

/**
 * The case-level SLA clock: how many hours a Service case gets before
 * `deadline_at`. Its own module because both readers of it — `services/assr.ts`
 * (create + priority change) and `routes/assr.ts` (the Service Maintenance
 * lookup that WRITES it) — are already at their file-size ceiling, and because
 * keeping the read and the write validation side by side is what stops them
 * drifting apart again. They did: see below.
 *
 * NOT to be confused with the per-STAGE clock, which is a separate axis living
 * in `lookupStageTargetDays()` (`assr_priority_stage_targets`, mig 082).
 */

type Priority = "low" | "normal" | "high" | "urgent";

/**
 * Last-resort SLA in hours per priority. NOT the source of truth — that is
 * `assr_priorities.sla_hours`, which Service Maintenance edits (mig 065 calls
 * the column "optional override of slaHoursFor()"). This table exists so a
 * missing row, a blank cell or an unreachable lookup table can never crash a
 * case create; it mirrors the backfill in 012_assr_sla.sql and the 065 seed so
 * the fallback and the seeded rows agree.
 *
 * `backend/scripts/check-assr-sla-priorities.mjs` carries a hand-copy of this
 * table (a script running against a production DSN cannot import a Worker
 * module); `backend/tests/assrSlaFallbackMirror.test.ts` fails if the two drift.
 */
const SLA_HOURS_BY_PRIORITY: Record<Priority, number> = {
  urgent: 24,
  high: 72,
  normal: 168,  // 7 days
  low: 336,     // 14 days
};

export function slaHoursFor(priority: string | null | undefined): number {
  return SLA_HOURS_BY_PRIORITY[(priority as Priority) || "normal"] ?? 168;
}

/**
 * The SLA window for a priority slug, read from the lookup a manager edits.
 *
 * Until 2026-08-20 this did not exist and both callers used `slaHoursFor()`
 * alone: Service Maintenance offered an SLA Hours cell, `routes/assr.ts` saved
 * it, and NOTHING in `backend/src` ever selected the column — an edit returned
 * `{ ok: true }` and changed nothing.
 *
 * No `active` predicate, deliberately, matching `lookupStageTargetDays()`:
 * deactivating a priority must not swing the SLA of a case that still carries
 * it back to the constant.
 *
 * Wrapped in try/catch for the same reason the stage-target lookup is — a
 * config read must never be able to fail a case create.
 */
export async function slaHoursForPriority(
  env: Env,
  priority: string | null | undefined,
): Promise<number> {
  const slug = priority || "normal";
  try {
    const row = await env.DB.prepare(
      `SELECT sla_hours FROM assr_priorities WHERE slug = ? LIMIT 1`,
    )
      .bind(slug)
      .first<{ sla_hours: number | null }>();
    const hours = Number(row?.sla_hours);
    // Blank cell = "use the module default", which is what the UI's own
    // rowTitle promises. A stored non-positive or non-finite value is junk
    // rather than an instruction, so it takes the same path.
    if (Number.isFinite(hours) && hours > 0) return hours;
  } catch (e) {
    console.warn("[assrSla.slaHoursForPriority] priority read failed:", e);
  }
  return slaHoursFor(slug);
}

/**
 * `sla_hours` is READ back by `slaHoursForPriority()`, so what gets stored
 * decides a real deadline. Blank stays legitimate — it means "use the module
 * default", which is what the UI's own cell title promises — but a value that
 * is not a positive whole number is junk, and storing it would put the cell
 * straight back into the shape this module exists to remove: saved with
 * `{ ok: true }`, then silently ignored at read time.
 *
 * Returns the value to store, or `false` meaning "refuse with a 400".
 */
export function normalizeSlaHours(raw: unknown): number | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) return false;
  return n;
}
