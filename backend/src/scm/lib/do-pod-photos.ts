/* More photos on a Delivery Order's POD, in the DO's own store
   (delivery_orders.pod_photo_keys, the first also in pod_r2_key) — the same
   columns the crew's POD writes through PATCH /delivery-orders-mfg/:id/status.

   Two callers: the office adding photos to a DO that is already delivered
   (routes/delivery-order-pod-photos.ts), and a Delivery Planning job linked to
   the DO (dp_orders.do_id) filing its POD photos on that DO too
   (routes/delivery-job-progress.ts). Appends only, so a re-run adds nothing.

   pod_r2_key is the "this DO has a POD" flag the board and the POD-chasing
   agent read, so it is set only on a DO that has reached the customer; before
   that the photos sit in pod_photo_keys and the crew's own POD later keeps them
   (the status handler merges, never replaces). */
import { scopeToAllowedCompanies, scopeToCompanyIdOrOpen, type CompanyScopeCtx } from './companyScope';
import { podPhotoKeysOf } from './do-pod-attempts';
import { doHasArrived } from '../shared/do-shipped-states';

export const MAX_DO_POD_PHOTOS = 40;

/** The DO's photos with the new ones after them, no key twice. Pure. */
export function mergePodPhotoKeys(had: string[], add: string[]): string[] {
  return [...had, ...add.filter((k, i) => !had.includes(k) && add.indexOf(k) === i)];
}

export type AppendDoPodResult =
  | { ok: true; found: false }
  | { ok: true; found: true; added: number; keys: string[] }
  | { ok: false; reason: string };

export async function appendDoPodPhotos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
  sb: any,
  c: CompanyScopeCtx,
  doId: string,
  /** The company the caller acts in (the job's / the active one); null = any granted company. */
  companyId: number | null,
  keys: string[],
): Promise<AppendDoPodResult> {
  const scoped = <Q>(q: Q): Q => scopeToCompanyIdOrOpen(scopeToAllowedCompanies(q, c), companyId);
  const { data, error } = await scoped(
    sb.from('delivery_orders').select('id, status, pod_r2_key, pod_photo_keys').eq('id', doId),
  ).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ok: true, found: false };
  const row = data as { status: string | null; pod_r2_key: string | null; pod_photo_keys: unknown };
  const had = podPhotoKeysOf(row);
  const all = mergePodPhotoKeys(had, keys);
  if (all.length === had.length) return { ok: true, found: true, added: 0, keys: had };
  if (all.length > MAX_DO_POD_PHOTOS) return { ok: false, reason: `A delivery order keeps at most ${MAX_DO_POD_PHOTOS} POD photos.` };
  const patch: Record<string, unknown> = { pod_photo_keys: all, updated_at: new Date().toISOString() };
  if (doHasArrived(row.status) && !row.pod_r2_key) patch.pod_r2_key = all[0];
  const { error: upErr } = await scoped(sb.from('delivery_orders').update(patch).eq('id', doId));
  if (upErr) throw new Error(upErr.message);
  return { ok: true, found: true, added: all.length - had.length, keys: all };
}
