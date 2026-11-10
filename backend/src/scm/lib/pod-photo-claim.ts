/* Claim uploaded photos for a proof of delivery.

   Every POD photo goes up through the payment-slip pipeline (/slips init ->
   upload), which leaves a scm.pending_slip_uploads row at status 'uploaded'
   that EXPIRES (an hour, a day for a field photo). The slip reaper
   (lib/reaper.ts, lease_orphan_slips) deletes the R2 object of every expired
   'pending' / 'uploaded' row — and the SLIPS and POD buckets are the same
   houzs-erp bucket. A POD that never claimed its sessions therefore lost its
   photos once they expired.

   Claiming marks the sessions 'promoted' (the reaper skips those) and is also
   the ownership check. staff_id on this table is the pinned SCM system staff for
   EVERY caller, so it proves nothing; the uploader is the Houzs user id /slips
   init records in order_draft_id (lib/slip.ts parseFieldPhotoDraftId). A key is
   accepted, inside the caller's granted companies, when it is:
     - the caller's own upload (any stop, or none), or
     - a photo uploaded FOR THIS STOP by anyone: the crew share one stop
       (owner, 2026-11-10), and the route calling this has already refused a
       caller who is not on that stop's crew (or office with the whole board), or
     - a row with no uploader recorded (uploaded before the uploader was stamped
       on every upload) — only on a stop the route already admitted the caller
       to. Those rows expire within a day of this shipping, so this branch then
       matches nothing.
   A key already claimed for no order is accepted again, so a retried POD is not
   refused. */
import { scopeToAllowedCompanies, type CompanyScopeCtx } from './companyScope';
import { parseFieldPhotoDraftId } from './slip';

export const MAX_POD_KEYS = 20;

/** Who is claiming, and for which stop. `stopContext` is the stop's field-photo
 *  context (`do:<id>` / `job:<type>:<id>:<leg>`, the same string the screens
 *  upload with), or null when the claim is not for one stop — then only the
 *  caller's own uploads are accepted. */
export type PodPhotoClaimer = { houzsUserId: number | null; stopContext: string | null };

export function doStopContext(doId: string): string {
  return `do:${doId}`;
}

export function jobStopContext(job: { sourceType: string; sourceId: string; leg: string }): string {
  return `job:${job.sourceType}:${job.sourceId}:${job.leg}`;
}

/** May this caller attach the photo uploaded under `draftId`? Pure, so the rule
 *  is pinned directly. */
export function podPhotoClaimable(draftId: string | null | undefined, claimer: PodPhotoClaimer): boolean {
  const owner = parseFieldPhotoDraftId(draftId);
  if (!owner) return draftId == null && claimer.stopContext !== null;
  if (claimer.houzsUserId !== null && owner.uploaderId === claimer.houzsUserId) return true;
  return claimer.stopContext !== null && owner.context === claimer.stopContext;
}

export async function claimPodPhotos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
  sb: any,
  c: CompanyScopeCtx,
  claimer: PodPhotoClaimer,
  rawKeys: unknown[],
): Promise<{ ok: true; keys: string[] } | { ok: false; reason: string }> {
  const keys = [...new Set(rawKeys.filter((k): k is string => typeof k === 'string' && /^slips\//.test(k)))];
  if (!keys.length) return { ok: true, keys: [] };
  if (keys.length > MAX_POD_KEYS) return { ok: false, reason: `At most ${MAX_POD_KEYS} photos at a time.` };
  if (claimer.houzsUserId === null && claimer.stopContext === null) return { ok: false, reason: 'Sign in again before uploading photos.' };
  const { data, error } = await scopeToAllowedCompanies(
    sb.from('pending_slip_uploads').select('id, r2_key, status, promoted_to_order_id, order_draft_id').in('r2_key', keys),
    c,
  );
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; r2_key: string; status: string; promoted_to_order_id: string | null; order_draft_id: string | null }>;
  const usable = rows.filter((r) =>
    (r.status === 'uploaded' || (r.status === 'promoted' && !r.promoted_to_order_id)) && podPhotoClaimable(r.order_draft_id, claimer));
  const usableKeys = new Set(usable.map((r) => r.r2_key));
  if (keys.some((k) => !usableKeys.has(k))) {
    return { ok: false, reason: 'A photo was not found among the photos for this stop, or it expired. Take it again and retry.' };
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
