/* Claim uploaded photos for a proof of delivery.

   Every POD photo goes up through the payment-slip pipeline (/slips init ->
   upload), which leaves a scm.pending_slip_uploads row at status 'uploaded'
   that EXPIRES in an hour. The slip reaper (lib/reaper.ts, lease_orphan_slips)
   deletes the R2 object of every expired 'pending' / 'uploaded' row — and the
   SLIPS and POD buckets are the same houzs-erp bucket. A POD that never claimed
   its sessions therefore lost its photos about an hour after the crew took them.

   Claiming marks the sessions 'promoted' (the reaper skips those) and is also
   the ownership check: a key is accepted only when it is an upload session of
   THIS caller in an allowed company — so nobody can attach (and then read back
   through a POD photo route) another user's slip or any other object in the
   shared bucket. A key the same caller already claimed is accepted again, so a
   retried POD is not refused. */
import { scopeToAllowedCompanies, type CompanyScopeCtx } from './companyScope';

export const MAX_POD_KEYS = 20;

export async function claimPodPhotos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
  sb: any,
  c: CompanyScopeCtx,
  staffId: string | null,
  rawKeys: unknown[],
): Promise<{ ok: true; keys: string[] } | { ok: false; reason: string }> {
  const keys = [...new Set(rawKeys.filter((k): k is string => typeof k === 'string' && /^slips\//.test(k)))];
  if (!keys.length) return { ok: true, keys: [] };
  if (keys.length > MAX_POD_KEYS) return { ok: false, reason: `At most ${MAX_POD_KEYS} photos at a time.` };
  if (!staffId) return { ok: false, reason: 'Sign in again before uploading photos.' };
  const { data, error } = await scopeToAllowedCompanies(
    sb.from('pending_slip_uploads').select('id, r2_key, status, promoted_to_order_id')
      .in('r2_key', keys).eq('staff_id', staffId),
    c,
  );
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; r2_key: string; status: string; promoted_to_order_id: string | null }>;
  const usable = rows.filter((r) => r.status === 'uploaded' || (r.status === 'promoted' && !r.promoted_to_order_id));
  const usableKeys = new Set(usable.map((r) => r.r2_key));
  if (keys.some((k) => !usableKeys.has(k))) {
    return { ok: false, reason: 'A photo was not found among your uploads, or it expired. Take it again and retry.' };
  }
  const toPromote = usable.filter((r) => r.status === 'uploaded').map((r) => r.id);
  if (toPromote.length) {
    const { error: upErr } = await scopeToAllowedCompanies(
      sb.from('pending_slip_uploads').update({ status: 'promoted', promoted_at: new Date().toISOString() })
        .in('id', toPromote).eq('status', 'uploaded'),
      c,
    );
    if (upErr) throw new Error(upErr.message);
  }
  return { ok: true, keys };
}
