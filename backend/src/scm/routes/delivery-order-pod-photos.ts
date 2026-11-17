/* POST /delivery-orders-mfg/:id/pod-photos — more POD photos on a Delivery Order
   that is already delivered (the office backing up a crew whose phone died, or a
   photo sent late). The job twin of POST /delivery-jobs/…/add-photos.

   Delivering a DO stays the status flip (PATCH /:id/status, DELIVERED + podKeys),
   which carries the SO sync and the customer message; this only appends to the
   same POD store and moves nothing. A separate file on the DO prefix because
   delivery-orders-mfg.ts is past its size ceiling; the prefix's area guard makes
   it a scm.sales.delivery edit, with no driver bypass. */
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { claimPodPhotos, doStopContext } from '../lib/pod-photo-claim';
import { houzsUserIdOf } from '../lib/crew-stop-complete';
import { appendDoPodPhotos } from '../lib/do-pod-photos';
import { doHasArrived } from '../shared/do-shipped-states';

export const deliveryOrderPodPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrderPodPhotos.use('*', supabaseAuth);

deliveryOrderPodPhotos.post('/:id/pod-photos', async (c) => {
  const id = c.req.param('id');
  let body: { photoKeys?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rawKeys = Array.isArray(body.photoKeys) ? body.photoKeys : [];
  if (!rawKeys.length) return c.json({ error: 'photo_required', reason: 'Choose at least one photo.' }, 400);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  try {
    const { data: cur, error: readErr } = await scopeToCompanyId(
      sb.from('delivery_orders').select('status').eq('id', id), co.companyId,
    ).maybeSingle();
    if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
    if (!cur) return c.json(NOT_THIS_COMPANY, 404);
    if (!doHasArrived((cur as { status: string | null }).status))
      return c.json({ error: 'not_delivered', reason: 'This delivery order is not delivered yet. Complete it with the photos instead.' }, 409);
    const claim = await claimPodPhotos(sb, c, { houzsUserId: houzsUserIdOf(c), stopContext: doStopContext(id) }, rawKeys);
    if (!claim.ok) return c.json({ error: 'photo_not_accepted', reason: claim.reason }, 400);
    if (!claim.keys.length) return c.json({ error: 'photo_required', reason: 'Choose at least one photo.' }, 400);
    const r = await appendDoPodPhotos(sb, c, id, co.companyId, claim.keys);
    if (!r.ok) return c.json({ error: 'too_many_photos', reason: r.reason }, 400);
    if (!r.found) return c.json(NOT_THIS_COMPANY, 404);
    return c.json({ deliveryOrder: { id, pod_photo_keys: r.keys }, added: r.added });
  } catch (e) {
    return c.json({ error: 'update_failed', reason: (e as Error).message }, 500);
  }
});
