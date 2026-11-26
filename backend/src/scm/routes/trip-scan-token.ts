import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { getOrCreateScanToken } from '../lib/do-scan-token';

export const tripScanToken = new Hono<{ Bindings: Env; Variables: Variables }>();
tripScanToken.use('*', supabaseAuth);

tripScanToken.get('/:id/scan-token', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const minted = await getOrCreateScanToken(sb, 'trips', id, co.companyId);
  if (minted.status === 'read_failed') {
    return c.json({
      error: 'scan_token_unavailable',
      message: "We couldn't reach this run just now. Try printing again in a moment.",
    }, 503);
  }
  if (minted.status === 'not_found') return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ scanToken: minted.token });
});
