import type { SlipEnv } from './slip';

export interface ReapResult {
  claimed: number;
  deleted: number;
  errors: number;
  remaining: number;
}

/**
 * Single reaper pass: lease up to 100 orphan slip rows via SECURITY DEFINER
 * Postgres function (atomic SKIP LOCKED claim), then delete the R2 object
 * for each + mark row failed.
 *
 * Idempotent: if R2 delete fails, row stays claimed; lease expires in 5 min
 * and the next reaper pass picks it up. If R2 delete succeeds but DB update
 * fails, next pass re-deletes (R2 404 treated as success).
 */
export async function reapOnce(supabase: any, env: SlipEnv, workerId: string): Promise<ReapResult> {
  const { data: claimed, error: claimErr } = await supabase.rpc('lease_orphan_slips', {
    p_worker_id: workerId,
    p_limit: 100,
  });

  if (claimErr) {
    return { claimed: 0, deleted: 0, errors: 1, remaining: 0 };
  }

  const rows = (claimed ?? []) as { id: string; r2_key: string }[];
  let deleted = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      await env.SLIPS!.delete(row.r2_key);
      const { error: updateErr } = await supabase
        .from('pending_slip_uploads')
        .update({ status: 'failed', error_msg: 'reaper: expired' })
        .eq('id', row.id);
      if (updateErr) {
        errors++;
      } else {
        deleted++;
      }
    } catch {
      errors++;
    }
  }

  const { data: remaining } = await supabase.rpc('count_orphan_slips');
  return { claimed: rows.length, deleted, errors, remaining: remaining ?? 0 };
}
