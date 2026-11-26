
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { assemblePvBatchPdf, type PdfAttachment } from '../lib/pdf-attach';
import { decodeBase64, loadDocAttachments, type DocFilesSpec } from '../lib/doc-files';
import { AP_INVOICE_FILES } from './ap-invoice-files';
import { CREDIT_NOTE_FILES } from './credit-note-files';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type BillKind = 'API' | 'PI' | 'SCN';

const MAX_BUNDLE_PARTS = 30;
const MAX_PAGE_BYTES = 10 * 1024 * 1024;

const kindOf = (v: unknown): BillKind | null => (v === 'API' || v === 'PI' || v === 'SCN' ? v : null);

type Paper =
  | { state: 'found'; number: string; files: Pick<DocFilesSpec, 'table' | 'fkColumn'> | null }
  | { state: 'missing' }
  | { state: 'failed'; reason: string };

const numberIn = (data: unknown, column: string): string => String((data as Record<string, unknown>)[column] ?? '');

async function loadPaper(c: Ctx, kind: BillKind, id: string): Promise<Paper> {
  const sb = c.get('supabase');
  switch (kind) {
    case 'API': {
      const { data, error } = await scopeToCompany(sb.from('ap_invoices').select('id, invoice_number').eq('id', id), c).maybeSingle();
      if (error) return { state: 'failed', reason: error.message };
      if (!data) return { state: 'missing' };
      return { state: 'found', number: numberIn(data, 'invoice_number'), files: AP_INVOICE_FILES };
    }
    case 'SCN': {
      const { data, error } = await scopeToCompany(sb.from('acc_credit_notes').select('id, note_number').eq('id', id).eq('kind', 'SCN'), c).maybeSingle();
      if (error) return { state: 'failed', reason: error.message };
      if (!data) return { state: 'missing' };
      return { state: 'found', number: numberIn(data, 'note_number'), files: CREDIT_NOTE_FILES };
    }
    case 'PI': {
      const { data, error } = await scopeToCompany(sb.from('purchase_invoices').select('id, invoice_number').eq('id', id), c).maybeSingle();
      if (error) return { state: 'failed', reason: error.message };
      if (!data) return { state: 'missing' };
      return { state: 'found', number: numberIn(data, 'invoice_number'), files: null };
    }
  }
}

export const printApBillsBundleHandler = async (c: Ctx): Promise<Response> => {
  const bucket = c.env.SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ error: 'no_company' }, 409);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rawParts = (body as { parts?: unknown } | null)?.parts;
  const parts: unknown[] = Array.isArray(rawParts) ? rawParts : [];
  if (parts.length === 0) return c.json({ error: 'no_parts', message: 'Nothing to print.' }, 400);
  if (parts.length > MAX_BUNDLE_PARTS) {
    return c.json({ error: 'too_many_parts', message: `A print with files is capped at ${MAX_BUNDLE_PARTS} documents — tick fewer, or print without files.` }, 400);
  }

  const assembled: Array<{ voucher: ArrayBuffer; files: PdfAttachment[] }> = [];
  let firstNumber = '';
  for (const part of parts as Array<{ kind?: unknown; id?: unknown; pageBase64?: unknown } | null>) {
    if (!part || typeof part !== 'object') return c.json({ error: 'bad_part', message: 'Each part names its kind (API, PI or SCN) and its id.' }, 400);
    const kind = kindOf(part.kind);
    const id = String(part.id ?? '');
    if (!kind || !id) return c.json({ error: 'bad_part', message: 'Each part names its kind (API, PI or SCN) and its id.' }, 400);
    const paper = await loadPaper(c, kind, id);
    if (paper.state === 'failed') return c.json({ error: 'load_failed', reason: paper.reason }, 500);
    if (paper.state === 'missing') return c.json({ error: 'not_found', message: `Document ${id} could not be loaded — nothing was printed.` }, 404);
    firstNumber ||= paper.number;

    const page = decodeBase64(String(part.pageBase64 ?? ''));
    if (!page || page.byteLength === 0) {
      return c.json({ error: 'bad_page', message: `${paper.number}'s rendered page did not arrive intact.` }, 400);
    }
    if (page.byteLength > MAX_PAGE_BYTES) return c.json({ error: 'page_too_large', message: `${paper.number}'s rendered page is too large to print.` }, 400);

    let files: PdfAttachment[] = [];
    if (paper.files) {
      const own = await loadDocAttachments(c, bucket, paper.files, id);
      if ('error' in own) return c.json({ error: 'load_failed', reason: own.error }, 500);
      files = own.files;
    }
    assembled.push({ voucher: page.buffer as ArrayBuffer, files });
  }

  const merged = await assemblePvBatchPdf(assembled);
  const name = parts.length === 1 ? `${firstNumber || 'supplier-bill'}.pdf` : 'supplier-bills.pdf';
  return new Response(merged as unknown as BodyInit, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${name.replace(/"/g, '')}"`,
      'cache-control': 'no-store',
    },
  });
};
