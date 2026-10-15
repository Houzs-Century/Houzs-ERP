// ----------------------------------------------------------------------------
// Original scans (HC-0006 T7): open the file a document was read from, and
// record who opened it and when (scm.scan_file_views).
//
//   GET /scan-files/<kind>/doc/:documentId   the document's kept originals
//   GET /scan-files/<kind>/:id/content       the bytes, inline; writes a view row
//
// One router per kind, so scm/index.ts puts each behind the area guard of the
// document it belongs to (SO + payment: sales orders; pv: accounting;
// workshop: transportation). Any other kind is simply not routed.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env } from '../../types';
import type { Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { requireActiveCompanyId } from '../lib/companyScope';
import type { ScanFileKind } from '../lib/scan-files';

const COLS = 'id, kind, mime, size_bytes, uploaded_by, created_at';

type Row = Record<string, unknown>;
type Ctx = {
  env: { SO_ITEM_PHOTOS?: { get(key: string): Promise<{ body: BodyInit } | null> } };
  req: { param(name: string): string | undefined };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Hono context; supabase is the schema-parameterised service client
  get(key: string): any;
  json(body: unknown, status?: number): Response;
};

const notFound = (c: Ctx) => c.json({ error: 'not_found' }, 404);

export const listScanFilesHandler = async (kind: ScanFileKind, c: Ctx): Promise<Response> => {
  const documentId = c.req.param('documentId') ?? '';
  if (!documentId) return notFound(c);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await c.get('supabase').from('scan_files').select(COLS)
    .eq('company_id', co.companyId).eq('kind', kind).eq('document_id', documentId)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ files: (data ?? []) as Row[] });
};

export const scanFileContentHandler = async (kind: ScanFileKind, c: Ctx): Promise<Response> => {
  const id = c.req.param('id') ?? '';
  if (!id) return notFound(c);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: row, error } = await sb.from('scan_files').select('id, storage_key, mime')
    .eq('company_id', co.companyId).eq('kind', kind).eq('id', id).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) return notFound(c);
  const bucket = c.env.SO_ITEM_PHOTOS;
  if (!bucket) return c.json({ error: 'r2_not_configured' }, 500);
  const obj = await bucket.get(String((row as Row).storage_key));
  if (!obj) return c.json({ error: 'object_missing', message: 'The scan is indexed but its file is gone.' }, 404);

  /* The trail is the point of this endpoint: no row, no bytes. */
  const { error: viewErr } = await sb.from('scan_file_views').insert({
    company_id: co.companyId,
    scan_file_id: id,
    viewed_by: String((c.get('user') as { id?: unknown } | undefined)?.id ?? '') || null,
  });
  if (viewErr) return c.json({ error: 'view_not_recorded', reason: viewErr.message }, 500);

  return new Response(obj.body, {
    headers: {
      'content-type': String((row as Row).mime),
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
    },
  });
};

const scanFileRouter = (kind: ScanFileKind) => {
  const r = new Hono<{ Bindings: Env; Variables: Variables }>();
  r.use('*', supabaseAuth);
  r.get('/doc/:documentId', (c) => listScanFilesHandler(kind, c as unknown as Ctx));
  r.get('/:id/content', (c) => scanFileContentHandler(kind, c as unknown as Ctx));
  return r;
};

export const scanFilesSo = scanFileRouter('so');
export const scanFilesPayment = scanFileRouter('payment');
export const scanFilesPv = scanFileRouter('pv');
export const scanFilesWorkshop = scanFileRouter('workshop');
