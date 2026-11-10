/* Earlier delivery attempts of a Delivery Order (owner-approved 2026-11-10).

   "Undo delivered" takes a wrong Delivered back to Loaded. The proof of delivery
   taken that time (photos, signature, GPS, the run's times) is evidence the
   customer saw goods arrive, so it is copied into scm.delivery_order_pod_attempts
   and cleared from the order; the driver's real POD then fills the order fresh.
   Nothing here deletes an R2 object: the attempt row just references the same
   keys the order did. Read path: routes/delivery-order-pod-attempts.ts. */
import { scopeToCompanyId } from './companyScope';

export const POD_SET_COLUMNS =
  'departure_at, arrival_at, signature_data, pod_r2_key, pod_photo_keys, pod_lat, pod_lng, pod_accuracy_m, pod_located_at';

export type PodSet = {
  departure_at?: string | null;
  arrival_at?: string | null;
  signature_data?: string | null;
  pod_r2_key?: string | null;
  pod_photo_keys?: unknown;
  pod_lat?: number | null;
  pod_lng?: number | null;
  pod_accuracy_m?: number | null;
  pod_located_at?: string | null;
};

/* departure_at / arrival_at stay on the order: the lorry did leave and arrive,
   and the next run re-stamps them. Only the evidence of the handover clears. */
export const CLEARED_POD_SET = {
  signature_data: null,
  pod_r2_key: null,
  pod_photo_keys: [] as string[],
  pod_lat: null,
  pod_lng: null,
  pod_accuracy_m: null,
  pod_located_at: null,
};

/** Every photo key of a POD set; a POD from before multi-photo has only pod_r2_key. */
export function podPhotoKeysOf(s: Pick<PodSet, 'pod_photo_keys' | 'pod_r2_key'>): string[] {
  const keys = Array.isArray(s.pod_photo_keys) ? s.pod_photo_keys.filter((k): k is string => typeof k === 'string' && !!k) : [];
  if (keys.length) return keys;
  return s.pod_r2_key ? [s.pod_r2_key] : [];
}

export async function archivePodAttempt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
  sb: any,
  a: {
    doId: string;
    companyId: number;
    from: string;
    reason: string;
    now: string;
    caller: { id?: unknown; name?: string | null } | undefined;
    row: PodSet & { delivered_at?: string | null; signed_at?: string | null };
  },
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const { data: prior, error: priorErr } = await scopeToCompanyId(
    sb.from('delivery_order_pod_attempts').select('attempt_no').eq('delivery_order_id', a.doId),
    a.companyId,
  );
  if (priorErr) return { ok: false, reason: priorErr.message };
  const last = ((prior as Array<{ attempt_no?: number | null }> | null) ?? [])
    .reduce((m, r) => Math.max(m, Number(r.attempt_no ?? 0)), 0);
  const undoneBy = Number(a.caller?.id);
  const { data, error } = await sb.from('delivery_order_pod_attempts').insert({
    company_id: a.companyId,
    delivery_order_id: a.doId,
    attempt_no: last + 1,
    undone_at: a.now,
    undone_by: Number.isFinite(undoneBy) ? undoneBy : null,
    undone_by_name: a.caller?.name ?? null,
    reason: a.reason,
    from_status: a.from,
    departure_at: a.row.departure_at ?? null,
    arrival_at: a.row.arrival_at ?? null,
    signed_at: a.row.signed_at ?? null,
    delivered_at: a.row.delivered_at ?? null,
    signature_data: a.row.signature_data ?? null,
    pod_r2_key: a.row.pod_r2_key ?? null,
    pod_photo_keys: podPhotoKeysOf(a.row),
    pod_lat: a.row.pod_lat ?? null,
    pod_lng: a.row.pod_lng ?? null,
    pod_accuracy_m: a.row.pod_accuracy_m ?? null,
    pod_located_at: a.row.pod_located_at ?? null,
  }).select('id').single();
  if (error || !data) return { ok: false, reason: error?.message ?? 'no row returned' };
  return { ok: true, id: String((data as { id: string }).id) };
}

/** Undo the copy when the order's own flip did not apply (lost race / write error). */
export async function dropPodAttempt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client
  sb: any,
  attemptId: string,
  companyId: number,
): Promise<void> {
  try {
    await scopeToCompanyId(sb.from('delivery_order_pod_attempts').delete().eq('id', attemptId), companyId);
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.error('[do-revert] could not drop the unused POD attempt:', e);
  }
}
