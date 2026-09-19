// ---------------------------------------------------------------------------
// pi-scan-extract — the supplier-INVOICE OCR: one Claude vision call that reads
// a supplier's printed invoice into the fields the matcher needs to find our
// OPEN Goods Receipt(s) and convert them into a DRAFT Purchase Invoice.
//
// The MIRROR of the SO scanner's callClaudeSlipExtract (routes/scan-so.ts),
// but invoice-shaped instead of sale-slip-shaped, and far smaller: an invoice
// is computer-generated clean text (the samples are DIGLANT invoices), so there
// is no catalog to inject and no handwriting to distil — the whole prompt is
// static except the few-shot pool of PREVIOUSLY-CONFIRMED reads (the same
// so_scan_samples table, partitioned document_type='PI'), which is how the
// reader self-improves.
//
// SAFETY: this only READS. It moves no money and creates nothing. Its output is
// data for pi-scan-match.ts, which finds the GRN; the DRAFT PI is raised by
// pi-from-grn-core.ts. temperature=0 for deterministic, reproducible OCR.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import {
  CLAUDE_MODEL, anthropicFetchWithRetry, stripJsonFences, type ContentBlock,
} from './scan-ocr';

// The scm service client is schema-parameterised (db:{schema:'scm'}); the bare
// generic does not accept it, so the loosened alias every scan module uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised client, same alias as scan-so.ts / scan-sample-review.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/** One invoice line as the model reads it. Every field is nullable — a supplier
 *  invoice that omits a column must not make the whole read fail. Prices are the
 *  RM major-unit numbers printed on the page (converted to sen by the matcher /
 *  never used to price the DRAFT PI, which inherits the GRN's own price). */
export type PiScanLine = {
  itemCode: string | null;
  articleNo: string | null;
  description: string | null;
  qty: number | null;
  unitPrice: number | null;
  salesTax: number | null;
  lineTotal: number | null;
};

/** The whole invoice, normalized. `docNo` / `poNo` are the matcher's primary
 *  keys (our grns.delivery_note_ref and purchase_orders.po_number). */
export type PiScanExtract = {
  supplierName: string | null;
  supplierCode: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD or null
  poNo: string | null;
  doNo: string | null;
  lines: PiScanLine[];
};

export type PiExtractCall = {
  parsed: PiScanExtract | null;
  errorMsg: string | null;
  timedOut: boolean;
  claudeText: string;
};

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return typeof v === 'number' ? String(v) : null;
  const t = v.trim();
  return t === '' ? null : t;
};
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Strip currency symbols, thousands separators and spaces: "RM 1,234.50".
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// YYYY-MM-DD if the model produced something date-shaped; else null. The DRAFT
// PI's invoice_date defaults to today when this is null (pi-from-grn-core), so a
// mis-read date never blocks the draft.
function coerceDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Coerce the model's JSON into PiScanExtract shape. Never throws — a malformed
 *  blob degrades to a mostly-null extract the matcher will fail to review. */
export function normalizePiExtract(raw: unknown): PiScanExtract {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const rawLines = Array.isArray(o.lines) ? o.lines : [];
  const lines: PiScanLine[] = rawLines.map((l) => {
    const r = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    return {
      itemCode: str(r.itemCode),
      articleNo: str(r.articleNo),
      description: str(r.description),
      qty: num(r.qty),
      unitPrice: num(r.unitPrice),
      salesTax: num(r.salesTax),
      lineTotal: num(r.lineTotal),
    };
  });
  return {
    supplierName: str(o.supplierName),
    supplierCode: str(o.supplierCode),
    invoiceNumber: str(o.invoiceNumber),
    invoiceDate: coerceDate(o.invoiceDate),
    poNo: str(o.poNo),
    doNo: str(o.doNo),
    lines,
  };
}

const PI_SCAN_PROMPT =
  'You are reading a SUPPLIER INVOICE (a printed bill a furniture supplier sends us for goods ' +
  'we already received). Extract it as VALID JSON ONLY — no preamble, no markdown fences, no ' +
  'explanation. The first character of your reply must be "{" and the last "}".\n\n' +
  'Return this exact shape:\n' +
  '{\n' +
  '  "supplierName": string|null,   // the supplier company name printed on the invoice\n' +
  '  "supplierCode": string|null,   // a supplier/account code if printed, else null\n' +
  '  "invoiceNumber": string|null,  // the supplier\'s own invoice number\n' +
  '  "invoiceDate": "YYYY-MM-DD"|null,\n' +
  '  "poNo": string|null,           // the Purchase Order number the invoice references (e.g. "PO-010070")\n' +
  '  "doNo": string|null,           // the Delivery Order / D.O. number the invoice references (e.g. "DGSN26001880")\n' +
  '  "lines": [\n' +
  '    {\n' +
  '      "itemCode": string|null,   // our item/stock code if printed\n' +
  '      "articleNo": string|null,  // the supplier\'s Article No / barcode / SKU if different from itemCode\n' +
  '      "description": string|null,\n' +
  '      "qty": number|null,\n' +
  '      "unitPrice": number|null,  // per-unit price in RM (a plain number, no "RM")\n' +
  '      "salesTax": number|null,   // sales/service tax on the line in RM, else null\n' +
  '      "lineTotal": number|null   // the line amount in RM\n' +
  '    }\n' +
  '  ]\n' +
  '}\n\n' +
  'RULES:\n' +
  '- Copy numbers and codes EXACTLY as printed. Never invent an item code, PO No or DO No that is not on the page — use null when it is not there.\n' +
  '- If a value like Article No is printed separately from our item code, put each in its own field.\n' +
  '- One object per invoice line item. Ignore subtotal / tax / grand-total summary rows — those are not lines.\n' +
  '- Prices are plain numbers in Ringgit (strip any "RM", commas or spaces).';

/**
 * Read a supplier invoice into PiScanExtract. ONE Claude vision call
 * (temperature 0), with the confirmed-read few-shot pool injected after a
 * cached static prefix. Best-effort: any transport / parse failure returns
 * `parsed: null` and the caller lands a needs-review outcome.
 */
export async function callClaudePiExtract(
  apiKey: string,
  fewShotText: string,
  fileBlocks: ContentBlock[],
): Promise<PiExtractCall> {
  let errorMsg: string | null = null;
  let timedOut = false;
  let parsed: PiScanExtract | null = null;
  let claudeText = '';

  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      signal: AbortSignal.timeout(110_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              // Static instructions cached for 1h — reused across back-to-back
              // invoice scans exactly like the SO catalog prefix.
              { type: 'text', text: PI_SCAN_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
              // Confirmed-read examples live AFTER the cache boundary (they grow
              // as operators confirm drafts) so they never bust the prefix.
              ...(fewShotText ? [{ type: 'text', text: fewShotText }] : []),
              ...fileBlocks,
              {
                type: 'text',
                text: 'Extract the supplier invoice above. Respond with VALID JSON ONLY, starting with "{" and ending with "}".',
              },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse;
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
        parsedResp = {};
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else {
        const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
        claudeText = stripJsonFences(firstText);
        try {
          parsed = normalizePiExtract(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      timedOut = true;
      errorMsg = 'OCR timed out — the invoice took too long to read. Please try again.';
    } else {
      errorMsg = `Network/fetch error: ${(e as Error).message}`;
    }
  }

  return { parsed, errorMsg, timedOut, claudeText };
}

/**
 * The few-shot pool: recent CONFIRMED / ACCEPTED PI reads (so_scan_samples,
 * document_type='PI'). Each is a supplier invoice the operator already accepted
 * as read correctly, so it is ground truth for the next scan. Best-effort — a
 * missing table / column just yields no examples and the reader still runs.
 */
export async function loadPiFewShot(svc: SupabaseClient, limit = 5): Promise<string> {
  try {
    const { data, error } = await svc
      .from('so_scan_samples')
      .select('corrected, extracted, status, created_at')
      .eq('document_type', 'PI')
      .in('status', ['ACCEPTED', 'CONFIRMED'])
      .order('created_at', { ascending: false })
      .limit(limit);
    // Best-effort: a read failure means "no examples this time", never a false
    // empty pool asserted as ground truth. The reader still runs without them.
    if (error) return '';
    const rows = (data as Array<{ corrected?: unknown; extracted?: unknown }> | null) ?? [];
    const examples = rows
      .map((r) => r.corrected ?? r.extracted)
      .filter((e) => e && typeof e === 'object')
      .map((e) => JSON.stringify(e));
    if (examples.length === 0) return '';
    return (
      'CONFIRMED PAST READS — supplier invoices previously read and accepted as ' +
      'correct. Use them as guidance for how these invoices are laid out (they ' +
      'complement, never override, the never-invent rule):\n\n' +
      examples.join('\n\n')
    );
  } catch {
    return '';
  }
}
