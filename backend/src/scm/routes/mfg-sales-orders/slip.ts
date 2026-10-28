import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { mimeFromKey } from '../../lib/r2';
import { slipBindings } from '../../lib/slip';

/* GET /:docNo/slip-url — moved out of mfg-sales-orders.ts, which calls this where the block
   stood, so registration order is unchanged. The body is moved verbatim and left
   unindented on purpose: source tests anchor on `\nmfgSalesOrders.<verb>(`. */
export function registerSlipRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
/* P1 (Owner 2026-06-03, migration 0143) — serve an SO's payment slip so the
   Backend SO detail page can display the proof. (Mirrored the legacy
   /orders/:id/slip-url route, removed 2026-06-12.) Auth is router-level (same
   as the SO detail GET); RLS governs which SOs the caller can read.

   2026-07-04 — converted from returning a presigned S3 GET URL (JSON {url})
   to STREAMING the object through the SLIPS binding, part of killing the
   never-provisioned R2 S3 creds (see routes/slips.ts header). The frontend
   (vendor/scm/lib/slip.ts fetchSoSlipUrl / fetchPaymentSlipUrl) blob-fetches
   this and hands consumers an object URL, keeping their {url, contentType}
   contract intact. */
mfgSalesOrders.get('/:docNo/slip-url', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  /* This route does not return a row, it streams the R2 OBJECT the row points
     at — so an unscoped lookup hands over the other company's payment slip
     itself, not a field of it. */
  const { data: row, error } = await scopeToCompany(sb
    .from('mfg_sales_orders')
    .select('slip_key')
    .eq('doc_no', docNo), c)
    .maybeSingle();
  if (error) return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const slipKey = (row as { slip_key?: string | null }).slip_key ?? null;
  if (!slipKey) return c.json({ error: 'no_slip_attached' }, 400);

  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(slipKey);
  if (!obj) return c.json({ error: 'file_not_in_r2' }, 404);
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? mimeFromKey(slipKey),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
});
}
