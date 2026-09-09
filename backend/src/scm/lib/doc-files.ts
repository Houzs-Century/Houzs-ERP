// ----------------------------------------------------------------------------
// doc-files — ONE home for a money document's EVIDENCE: the files it keeps
// beside itself (a voucher's scanned bill, an AP invoice's supplier bill).
//
// Born 2026-09-06 when the AP invoice wanted what the PV already had (owner:
// 附件也一起做). routes/pv-files.ts (2026-09-03) was the only copy; a second
// document meant a second MIME allowlist, size cap, key layout and four
// handlers — so the copy became this factory. What differs per document is
// the spec: the index table and its FK column, the R2 key prefix, who may
// write, how the document loads, and the two refusals — a CLOSED document
// takes no more evidence, a LOCKED one keeps what it has.
//
// Bytes live in the SLIPS R2 bucket (the one binding that exists — see
// slips.ts's history) under <keyPrefix>/<company>/<doc>/<uuid>.<ext>; the
// index row's sort_no = attach order = print order. Reading rides the
// document's own guard; upload and delete take the spec's write keys.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from './houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from './companyScope';
import type { PdfAttachment } from './pdf-attach';

type Row = Record<string, any>;

/* The scan reader's own inputs plus PDF — one bill, one document, one truth. */
export const DOC_FILE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export const MAX_DOC_FILE_BYTES = 20 * 1024 * 1024; // the scan pipeline's own per-file cap

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

/** What a spec's loader hands back: the document's id and the two states the
    handlers refuse on — `closed` takes no more evidence (cancelled), `locked`
    keeps what it has (checked / posted). */
export type DocForFiles = { id: string; closed: boolean; locked: boolean };

export type DocFilesSpec = {
  /** The index table (in scm) and the column that names the document. */
  table: string;
  fkColumn: string;
  /** R2 key layout: <keyPrefix>/<company>/<doc>/<uuid>.<ext>. */
  keyPrefix: string;
  /** Upload and delete need one of these; reading rides the document. */
  writePerms: readonly string[];
  /** The document under the active company — 404 when it is not there. */
  load: (c: any) => Promise<{ doc: DocForFiles } | { resp: Response }>;
  /** The refusals, worded for THIS document. */
  closedRefusal: { error: string; message: string };
  lockedRefusal: { error: string; message: string };
};

type Bucket = {
  put: (k: string, v: ArrayBuffer, o?: unknown) => Promise<unknown>;
  get: (k: string) => Promise<any>;
  delete: (k: string) => Promise<unknown>;
};

const bucketOf = (c: any): Bucket | undefined => (c.env as { SLIPS?: Bucket }).SLIPS;
const noBucket = (c: any): Response => c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);

export const decodeBase64 = (b64: string): Uint8Array | null => {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
};

export function makeDocFileHandlers(spec: DocFilesSpec) {
  const canWrite = (c: any): boolean => spec.writePerms.some((k) => hasHouzsPerm(c, k));
  const noPerm = (c: any): Response => c.json({ error: "You don't have permission to do that." }, 403);

  const upload = async (c: any): Promise<Response> => {
    if (!canWrite(c)) return noPerm(c);
    const bucket = bucketOf(c);
    if (!bucket) return noBucket(c);

    const found = await spec.load(c);
    if ('resp' in found) return found.resp;
    if (found.doc.closed) return c.json(spec.closedRefusal, 409);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    const fileName = String(body.fileName ?? '').trim() || 'bill';
    const mime = String(body.mime ?? '').trim().toLowerCase();
    const b64 = String(body.dataBase64 ?? '');
    if (!DOC_FILE_MIMES.has(mime)) {
      return c.json({ error: 'bad_mime', message: `${mime || '(none)'} is not an image or a PDF.` }, 400);
    }
    if (!b64) return c.json({ error: 'no_data' }, 400);
    const bytes = decodeBase64(b64);
    if (!bytes) return c.json({ error: 'bad_base64' }, 400);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOC_FILE_BYTES) {
      return c.json({ error: 'bad_size', message: `Files are capped at ${MAX_DOC_FILE_BYTES / 1024 / 1024}MB.` }, 400);
    }

    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json({ error: 'no_company' }, 409);
    const sb = c.get('supabase');

    const { data: existing, error: exErr } = await sb.from(spec.table)
      .select('sort_no').eq('company_id', co.companyId).eq(spec.fkColumn, found.doc.id);
    if (exErr) return c.json({ error: 'load_failed', reason: exErr.message }, 500);
    const sortNo = ((existing ?? []) as Row[]).reduce((m, r) => Math.max(m, Number(r.sort_no ?? 0)), 0) + 1;

    const fileKey = `${spec.keyPrefix}/${co.companyId}/${found.doc.id}/${crypto.randomUUID()}.${EXT[mime]}`;
    await bucket.put(fileKey, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType: mime } });

    const { data: row, error: insErr } = await sb.from(spec.table).insert({
      company_id: co.companyId,
      [spec.fkColumn]: found.doc.id,
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

  const list = async (c: any): Promise<Response> => {
    const found = await spec.load(c);
    if ('resp' in found) return found.resp;
    const sb = c.get('supabase');
    const { data, error } = await scopeToCompany(
      sb.from(spec.table).select('id, file_name, mime, size_bytes, sort_no, created_at').eq(spec.fkColumn, found.doc.id), c,
    ).order('sort_no');
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    return c.json({ files: data ?? [] });
  };

  const stream = async (c: any): Promise<Response> => {
    const bucket = bucketOf(c);
    if (!bucket) return noBucket(c);
    const found = await spec.load(c);
    if ('resp' in found) return found.resp;
    const sb = c.get('supabase');
    const { data: row, error } = await scopeToCompany(
      sb.from(spec.table).select('file_key, mime, file_name').eq(spec.fkColumn, found.doc.id).eq('id', c.req.param('fileId')), c,
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

  const remove = async (c: any): Promise<Response> => {
    if (!canWrite(c)) return noPerm(c);
    const bucket = bucketOf(c);
    if (!bucket) return noBucket(c);
    const found = await spec.load(c);
    if ('resp' in found) return found.resp;
    /* Evidence locks with the document: checked 的人就不可以改了. */
    if (found.doc.locked) return c.json(spec.lockedRefusal, 409);
    const sb = c.get('supabase');
    const { data: row, error } = await scopeToCompany(
      sb.from(spec.table).select('id, file_key, company_id').eq(spec.fkColumn, found.doc.id).eq('id', c.req.param('fileId')), c,
    ).maybeSingle();
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const { error: delErr } = await sb.from(spec.table)
      .delete().eq('company_id', (row as Row).company_id).eq('id', (row as Row).id);
    if (delErr) return c.json({ error: 'delete_failed', reason: delErr.message }, 500);
    await bucket.delete((row as Row).file_key);
    return c.json({ ok: true });
  };

  return { upload, list, stream, remove };
}

/**
 * A document's stored files as print attachments, sort order. A row whose R2
 * object is gone becomes a notice page (the index said it existed; paper must
 * say it didn't print). `label` prefixes each file's name so the notice page
 * can say WHICH document's file it was — the bundle prints a voucher's own
 * files unlabelled and the bills it pays under their invoice number.
 */
export async function loadDocAttachments(
  c: any,
  bucket: Pick<Bucket, 'get'>,
  spec: Pick<DocFilesSpec, 'table' | 'fkColumn'>,
  docId: string,
  label = '',
): Promise<{ files: PdfAttachment[] } | { error: string }> {
  const sb = c.get('supabase');
  const { data: fileRows, error: listErr } = await scopeToCompany(
    sb.from(spec.table).select('file_key, file_name, mime, sort_no').eq(spec.fkColumn, docId), c,
  ).order('sort_no');
  if (listErr) return { error: listErr.message };
  const files: PdfAttachment[] = [];
  for (const row of (fileRows ?? []) as Row[]) {
    const name = label ? `${label} · ${String(row.file_name)}` : String(row.file_name);
    const obj = await bucket.get(String(row.file_key));
    if (!obj) {
      files.push({ fileName: `${name} (stored file missing)`, mime: 'application/x-missing', bytes: new ArrayBuffer(0) });
      continue;
    }
    const bytes: ArrayBuffer = typeof obj.arrayBuffer === 'function'
      ? await obj.arrayBuffer()
      : await new Response(obj.body).arrayBuffer();
    files.push({ fileName: name, mime: String(row.mime), bytes });
  }
  return { files };
}
