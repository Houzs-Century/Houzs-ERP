import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany } from '../lib/companyScope';
import { podPhotoKeysOf } from '../lib/do-pod-attempts';
import { podPhotoResponse } from './delivery-pod-context';

export const deliveryOrderPodAttempts = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrderPodAttempts.use('*', supabaseAuth);

const LIST_COLUMNS =
  'id, delivery_order_id, attempt_no, undone_at, undone_by, undone_by_name, reason, from_status, ' +
  'departure_at, arrival_at, signed_at, delivered_at, signature_data, pod_r2_key, pod_photo_keys, pod_lat, pod_lng, pod_located_at';

deliveryOrderPodAttempts.get('/:id/pod-attempts', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb.from('delivery_order_pod_attempts').select(LIST_COLUMNS).eq('delivery_order_id', c.req.param('id')),
    c,
  ).order('attempt_no', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = data as unknown as Array<Record<string, unknown>>;
  const attempts = rows.map(({ pod_photo_keys, pod_r2_key, ...r }) => ({
    ...r,
    photo_count: podPhotoKeysOf({ pod_photo_keys, pod_r2_key: pod_r2_key as string | null }).length,
  }));
  return c.json({ attempts });
});

deliveryOrderPodAttempts.get('/:id/pod-attempts/:attemptId/photo/:n', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb.from('delivery_order_pod_attempts').select('pod_r2_key, pod_photo_keys')
      .eq('id', c.req.param('attemptId')).eq('delivery_order_id', c.req.param('id')),
    c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const key = data ? podPhotoKeysOf(data as { pod_r2_key: string | null; pod_photo_keys: unknown })[Number(c.req.param('n'))] : undefined;
  if (!key) return c.json({ error: 'not_found', reason: 'This earlier attempt has no such photo.' }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: 'not_found', reason: 'The POD photo file is missing from storage.' }, 404);
  return podPhotoResponse(obj);
});
