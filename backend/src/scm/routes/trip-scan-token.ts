import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { getOrCreateScanToken } from '../lib/do-scan-token';
import { mintLorryDayScanToken, parseLorryDaySheet } from '../lib/lorry-day-scan';

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

/* The packing list printed per lorry per delivery day (no trip behind it): its QR
   covers exactly the DOs printed on it. A GET like the trip mint above, so whoever
   may print a packing list may arm its QR. Every DO id must be this company's.
   company-scope: every DO id is checked against the session company before minting. */
tripScanToken.get('/lorry-day-scan-token', async (c) => {
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const parsed = parseLorryDaySheet({
    lorryPlate: c.req.query('plate'),
    deliveryDate: c.req.query('date'),
    doIds: (c.req.query('doIds') ?? '').split(',').filter(Boolean),
  });
  if (!parsed.ok) return c.json({ error: 'invalid_sheet', message: parsed.message }, 400);

  const user = c.get('user') as { id?: string } | null;
  const minted = await mintLorryDayScanToken(sb, co.companyId, parsed.sheet, user?.id ?? null);
  if (minted.status === 'read_failed') {
    return c.json({
      error: 'scan_token_unavailable',
      message: "We couldn't reach the system just now. Try printing again in a moment.",
    }, 503);
  }
  if (minted.status === 'foreign') {
    return c.json({
      error: 'not_this_company',
      message: 'Some delivery orders on this packing list are not in this company\'s books, so no QR was made.',
      doIds: minted.doIds,
    }, 404);
  }
  return c.json({ scanToken: minted.token });
});
