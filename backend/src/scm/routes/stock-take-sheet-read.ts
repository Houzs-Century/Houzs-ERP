// ----------------------------------------------------------------------------
// POST /stock-takes/:id/read-sheet — read ONE photographed page of a counted
// paper count sheet (owner 2026-10-06: 点完货填写在纸上，之后 upload 回去，要 OCR).
// The page is read by the model; which line each row is, and which rack a
// written label names, are decided in plain code (lib/stock-take-sheet.ts).
// NOTHING is written: the page shows the proposals, the counter ticks the ones
// that are right and applies them to the sheet, then saves as usual.
//
//   body  { files: [{ name, mime, dataBase64 }] }   one page (a photo or a PDF)
//   200   { takeNoRead, takeNoMatches, proposals, unmatched }
// ----------------------------------------------------------------------------

import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { CLAUDE_MODEL, IMAGE_MIMES, MAX_FILE_BYTES, anthropicFetchWithRetry, stripJsonFences, type AnthropicResponse } from '../lib/scan-ocr';
import { SHEET_READ_PROMPT, matchSheetRows, normalizeSheetRows, type SheetLine, type SheetRack } from '../lib/stock-take-sheet';

const MAX_FILES = 4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono context without generated types; same as every scm handler
export const readStockTakeSheetHandler = async (c: any): Promise<Response> => {
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const apiKey = c.env?.ANTHROPIC_API_KEY as string | undefined;
  if (!apiKey) return c.json({ error: 'anthropic_key_missing', message: 'Photo reading is not set up on this server.' }, 503);

  let body: { files?: unknown };
  try { body = (await c.req.json()) as { files?: unknown }; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const raw = Array.isArray(body.files) ? (body.files as Array<Record<string, unknown>>) : [];
  if (raw.length === 0) return c.json({ error: 'no_files', message: 'Send a photo of the counted sheet.' }, 400);
  if (raw.length > MAX_FILES) return c.json({ error: 'too_many_files', message: `At most ${MAX_FILES} files per read — send one page at a time.` }, 400);
  const blocks: Array<Record<string, unknown>> = [];
  for (const f of raw) {
    const mime = String(f.mime ?? '');
    const data = String(f.dataBase64 ?? '');
    if (!IMAGE_MIMES.has(mime) && mime !== 'application/pdf') {
      return c.json({ error: 'bad_file_type', message: `${mime || 'unknown type'} — JPEG / PNG / WebP / PDF only.` }, 400);
    }
    if (!data || Math.floor(data.length * 0.75) > MAX_FILE_BYTES) {
      return c.json({ error: 'file_too_big', message: 'A file is empty or over 20MB.' }, 400);
    }
    blocks.push(mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } });
  }

  const sb = c.get('supabase');
  const { data: head, error: hErr } = await scopeToCompanyId(
    sb.from('stock_takes').select('id, take_no, status, warehouse_id').eq('id', id), co.companyId,
  ).maybeSingle();
  if (hErr) return c.json({ error: 'load_failed', reason: hErr.message }, 500);
  if (!head) return c.json(NOT_THIS_COMPANY, 404);
  const take = head as { take_no: string; status: string; warehouse_id: string };
  if (take.status !== 'OPEN') return c.json({ error: 'not_open', message: 'Only an OPEN stock take takes counts.' }, 409);

  /* PRINT ORDER — the same order GET /:id returns and the PDF numbers. */
  const [linesRes, racksRes] = await Promise.all([
    scopeToCompanyId(sb.from('stock_take_lines').select('id, item_code, variant_label')
      .eq('stock_take_id', id), co.companyId)
      .order('item_code').order('variant_key').order('id'),
    scopeToCompanyId(sb.from('warehouse_racks').select('id, rack').eq('warehouse_id', take.warehouse_id), co.companyId),
  ]);
  if (linesRes.error) return c.json({ error: 'load_failed', reason: linesRes.error.message }, 500);
  if (racksRes.error) return c.json({ error: 'load_failed', reason: racksRes.error.message }, 500);

  let modelJson: unknown;
  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      signal: AbortSignal.timeout(110_000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        temperature: 0, // a wrong read must be reproducible, not a lottery
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: SHEET_READ_PROMPT }] }],
      }),
    });
    const out = (await resp.json()) as AnthropicResponse;
    if (!resp.ok) return c.json({ error: 'read_failed', message: out.error?.message ?? `The reader answered ${resp.status}.` }, 502);
    const text = (out.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    modelJson = JSON.parse(stripJsonFences(text));
  } catch (e) {
    return c.json({ error: 'read_failed', message: e instanceof Error ? e.message : 'The page could not be read.' }, 502);
  }

  const takeNoRead = typeof (modelJson as { takeNo?: unknown } | null)?.takeNo === 'string'
    ? String((modelJson as { takeNo: string }).takeNo).trim() || null
    : null;
  const { proposals, unmatched } = matchSheetRows(
    normalizeSheetRows(modelJson),
    (linesRes.data ?? []) as SheetLine[],
    (racksRes.data ?? []) as SheetRack[],
  );
  return c.json({
    takeNoRead,
    /* A page of ANOTHER take must not fill this one; the page says so and
       offers nothing to apply. null = the page did not show its number. */
    takeNoMatches: takeNoRead == null ? null : takeNoRead.toUpperCase() === take.take_no.toUpperCase(),
    proposals: takeNoRead != null && takeNoRead.toUpperCase() !== take.take_no.toUpperCase() ? [] : proposals,
    unmatched,
  });
};
