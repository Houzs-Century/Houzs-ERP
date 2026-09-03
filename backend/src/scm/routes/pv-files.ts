// ----------------------------------------------------------------------------
// PV attachments — the bill finally lives with its voucher (owner 2026-09-03:
// print pv include ocr 的文件一起; before this the scan flow READ the bill
// and kept nothing).
//
//   POST   /payment-vouchers/:id/files          {fileName, mime, dataBase64}
//   GET    /payment-vouchers/:id/files          the index rows
//   GET    /payment-vouchers/:id/files/:fileId  streams the bytes from R2
//   DELETE /payment-vouchers/:id/files/:fileId  until CHECKED — evidence
//          locks with the document (the owner's own four-layer rule).
//
// Bytes live in the SLIPS R2 bucket (the one binding that exists — see
// slips.ts's history) under pv-files/<company>/<pv>/<uuid>.<ext>; the index
// is scm.acc_pv_files (0352), sort_no = attach order = print order.
// Upload/delete take scm.payment_voucher.write; reading rides the voucher.
// Handlers exported bare for the vitest harness.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';

type Row = Record<string, any>;

/* The scan reader's own inputs plus PDF — one bill, one voucher, one truth. */
const PV_FILE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_PV_FILE_BYTES = 20 * 1024 * 1024; // the scan pipeline's own per-file cap

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

const loadPv = async (c: any): Promise<{ pv: Row } | { resp: Response }> => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb.from('payment_vouchers').select('id, pv_number, status, checked_at, company_id').eq('id', c.req.param('id')), c,
  ).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found' }, 404) };
  return { pv: data as Row };
};

export const uploadPvFileHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const bucket = (c.env as { SLIPS?: { put: (k: string, v: ArrayBuffer, o?: unknown) => Promise<unknown> } }).SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);

  const found = await loadPv(c);
  if ('resp' in found) return found.resp;
  if (found.pv.status === 'CANCELLED') {
    return c.json({ error: 'voucher_cancelled', message: 'A cancelled voucher takes no more evidence.' }, 409);
  }
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const fileName = String(body.fileName ?? '').trim() || 'bill';
  const mime = String(body.mime ?? '').trim().toLowerCase();
  const b64 = String(body.dataBase64 ?? '');
  if (!PV_FILE_MIMES.has(mime)) {
    return c.json({ error: 'bad_mime', message: `${mime || '(none)'} is not an image or a PDF.` }, 400);
  }
  if (!b64) return c.json({ error: 'no_data' }, 400);
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  } catch { return c.json({ error: 'bad_base64' }, 400); }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PV_FILE_BYTES) {
    return c.json({ error: 'bad_size', message: `Files are capped at ${MAX_PV_FILE_BYTES / 1024 / 1024}MB.` }, 400);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ error: 'no_company' }, 409);
  const sb = c.get('supabase');

  const { data: existing, error: exErr } = await sb.from('acc_pv_files')
    .select('sort_no').eq('company_id', co.companyId).eq('pv_id', found.pv.id);
  if (exErr) return c.json({ error: 'load_failed', reason: exErr.message }, 500);
  const sortNo = ((existing ?? []) as Row[]).reduce((m, r) => Math.max(m, Number(r.sort_no ?? 0)), 0) + 1;

  const fileKey = `pv-files/${co.companyId}/${found.pv.id}/${crypto.randomUUID()}.${EXT[mime]}`;
  await bucket.put(fileKey, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType: mime } });

  const { data: row, error: insErr } = await sb.from('acc_pv_files').insert({
    company_id: co.companyId,
    pv_id: found.pv.id,
    file_key: fileKey,
    file_name: fileName,
    mime,
    size_bytes: bytes.byteLength,
    sort_no: sortNo,
    created_by: String(c.get('user')?.id ?? ''),
  }).select('id, file_name, mime, size_bytes, sort_no').single();
  if (insErr || !row) return c.json({ error: 'save_failed', reason: insErr?.message ?? 'insert returned nothing' }, 500);
  return c.json({ ok: true, file: row }, 201);
};

export const listPvFilesHandler = async (c: any): Promise<Response> => {
  const found = await loadPv(c);
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const { data, error } = await scopeToCompany(
    sb.from('acc_pv_files').select('id, file_name, mime, size_bytes, sort_no, created_at').eq('pv_id', found.pv.id), c,
  ).order('sort_no');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ files: data ?? [] });
};

export const streamPvFileHandler = async (c: any): Promise<Response> => {
  const bucket = (c.env as { SLIPS?: { get: (k: string) => Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null> } }).SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);
  const found = await loadPv(c);
  if ('resp' in found) return found.resp;
  const sb = c.get('supabase');
  const { data: row, error } = await scopeToCompany(
    sb.from('acc_pv_files').select('file_key, mime, file_name').eq('pv_id', found.pv.id).eq('id', c.req.param('fileId')), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const obj = await bucket.get((row as Row).file_key);
  if (!obj) return c.json({ error: 'object_missing', message: 'The index row exists but the stored file is gone.' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': (row as Row).mime,
      'content-disposition': `inline; filename="${String((row as Row).file_name).replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=300',
    },
  });
};

export const deletePvFileHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const bucket = (c.env as { SLIPS?: { delete: (k: string) => Promise<unknown> } }).SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);
  const found = await loadPv(c);
  if ('resp' in found) return found.resp;
  /* Evidence locks with the document: checked 的人就不可以改了. */
  if (found.pv.checked_at) {
    return c.json({ error: 'evidence_locked', message: 'The voucher is checked — its evidence stays.' }, 409);
  }
  const sb = c.get('supabase');
  const { data: row, error } = await scopeToCompany(
    sb.from('acc_pv_files').select('id, file_key, company_id').eq('pv_id', found.pv.id).eq('id', c.req.param('fileId')), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const { error: delErr } = await sb.from('acc_pv_files')
    .delete().eq('company_id', (row as Row).company_id).eq('id', (row as Row).id);
  if (delErr) return c.json({ error: 'delete_failed', reason: delErr.message }, 500);
  await bucket.delete((row as Row).file_key);
  return c.json({ ok: true });
};
