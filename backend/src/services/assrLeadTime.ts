import type { Env } from "../types";

/**
 * Lead Time Portal — scheduled-activation processor (mig 080).
 *
 * Runs from the cron in src/index.ts. Picks every pending scheduled
 * activation whose scheduled_for is past or now, flips the active
 * profile to it, records the activation, and marks the schedule row
 * as fired.
 *
 * The new "active" profile takes effect for any case CREATED after
 * the flip — in-flight cases keep their stamped lead_time_profile_id
 * (proposal §10 "Effective date" rule). Same semantics as a manual
 * activation.
 */
export async function runScheduledLeadTimeActivations(
  env: Env
): Promise<{ fired: number }> {
  const due = await env.DB.prepare(
    `SELECT id, profile_id, scheduled_by
       FROM assr_lead_time_scheduled_activations
      WHERE status = 'pending'
        AND scheduled_for <= datetime('now')
      ORDER BY scheduled_for, id`
  ).all<{ id: number; profile_id: number; scheduled_by: number | null }>();

  let fired = 0;
  for (const row of due.results ?? []) {
    const prev = await env.DB.prepare(
      `SELECT id FROM assr_lead_time_profiles WHERE is_active = 1`
    ).first<{ id: number }>();

    // Belt-and-braces: skip if the profile no longer exists (shouldn't
    // happen — FK is ON DELETE CASCADE so a deleted profile takes its
    // schedule row with it — but D1's enforcement isn't always strict).
    const stillExists = await env.DB.prepare(
      `SELECT 1 FROM assr_lead_time_profiles WHERE id = ?`
    )
      .bind(row.profile_id)
      .first();
    if (!stillExists) {
      await env.DB.prepare(
        `UPDATE assr_lead_time_scheduled_activations
            SET status = 'cancelled',
                cancelled_at = datetime('now')
          WHERE id = ?`
      )
        .bind(row.id)
        .run();
      continue;
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE assr_lead_time_profiles
            SET is_active = 0, updated_at = datetime('now')`
      ),
      env.DB.prepare(
        `UPDATE assr_lead_time_profiles
            SET is_active = 1, updated_at = datetime('now')
          WHERE id = ?`
      ).bind(row.profile_id),
      env.DB.prepare(
        `INSERT INTO assr_lead_time_activations
           (profile_id, source, scheduled_id, user_id, previous_profile_id)
         VALUES (?, 'scheduled', ?, ?, ?)`
      ).bind(row.profile_id, row.id, row.scheduled_by, prev?.id ?? null),
      env.DB.prepare(
        `UPDATE assr_lead_time_scheduled_activations
            SET status = 'fired', fired_at = datetime('now')
          WHERE id = ?`
      ).bind(row.id),
    ]);
    fired++;
  }
  return { fired };
}
