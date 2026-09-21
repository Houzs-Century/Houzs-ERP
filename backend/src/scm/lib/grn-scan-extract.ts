// ---------------------------------------------------------------------------
// grn-scan-extract — the GR (Goods Receipt) OCR: prompt, extraction shape,
// defensive normaliser, the ONE Claude vision call, and the few-shot loader.
//
// The source document is a supplier DELIVERY ORDER (the DIGLANT samples are
// computer-generated, clean text): a header (supplier, P.O. No, D.O. No, date)
// and a line table (Item Code / Article No / Barcode, Description, Quantity).
// This is the DO twin of scan-so.ts's slip prompt; the transport primitives are
// shared from scan-ocr.ts, only the prompt + shape differ. See
// tasks/PLAN-ocr-scan-gr-pi.md and docs/modules/scan-to-gr.md.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import {
  CLAUDE_MODEL,
  anthropicFetchWithRetry,
  stripJsonFences,
  type AnthropicResponse,
  type ContentBlock,
} from './scan-ocr';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export type GrnExtractedLine = {
  // The supplier's printed item code / Article No.
  itemCode: string | null;
  barcode: string | null;
  description: string | null;
  qty: number;
};

export type GrnExtracted = {
  supplierName: string | null;
  // The supplier-printed P.O. No (e.g. "PO-010070") — their reference, matched
  // best-effort against our po_number, else item-matched (see grn-scan-match).
  poNo: string | null;
  doNo: string | null;
  // ISO yyyy-mm-dd when the DO date parses cleanly, else null.
  deliveryDate: string | null;
  lines: GrnExtractedLine[];
};

export type GrnExtractCall = {
  parsed: GrnExtracted | null;
  errorMsg: string | null;
  timedOut: boolean;
  claudeText: string;
  cacheHit: boolean;
};

const GR_SYSTEM_PROMPT = `You extract structured data from photos or PDFs of supplier DELIVERY ORDER documents (also called "D/O" or "Delivery Note") sent to a Malaysian furniture retailer. These are typically computer-generated, clean printed documents.

A delivery order has:
- A header: the SUPPLIER's name, a "P.O. No" (the purchase order number this delivery fulfils, e.g. "PO-010070" or "HC-PO-2609-166"), a "D.O. No" (the delivery order's own number), and a delivery/document date.
- A line-item table: each row has an item code / Article No / Barcode / product code, a description, and a quantity delivered. Some documents show BOTH an internal code column and a supplier Article No / Barcode column.

OUTPUT: valid JSON only, this exact shape:
{
  "supplierName": string | null,
  "poNo": string | null,
  "doNo": string | null,
  "deliveryDate": string | null,   // ISO "YYYY-MM-DD" if you can read a date, else null
  "lines": [
    {
      "itemCode": string | null,   // the item/product/Article No code as printed; prefer a code that looks like a SKU (letters+digits) over a free-text name
      "barcode": string | null,    // a separate barcode/EAN number if the row shows one distinct from itemCode
      "description": string | null,
      "qty": number                // the quantity delivered for this line; a positive number
    }
  ]
}

RULES:
- Transcribe codes EXACTLY as printed, including punctuation, spaces and letter case. Do NOT normalise, expand or "correct" a code.
- If a row shows only a description and no code, set itemCode to null and put the text in description.
- qty is the delivered quantity as a number (strip any unit like "PCS"/"UNIT"). If a row has no readable quantity, use 0.
- Ignore sub-total / total / remarks / signature rows — only real product lines go in "lines".
- Never invent a P.O. No, D.O. No or code you cannot read; use null.`;

// Defensive coercion — the model occasionally omits a field or returns the
// wrong primitive. Coerce into the GrnExtracted shape so downstream code never
// sees undefined where it expects an array/number.
export function normalizeGrnExtract(raw: unknown): GrnExtracted {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t;
  };
  const num = (v: unknown): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };
  const rawLines = Array.isArray(r.lines) ? r.lines : [];
  const lines: GrnExtractedLine[] = rawLines.map((l) => {
    const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    return {
      itemCode: str(o.itemCode),
      barcode: str(o.barcode),
      description: str(o.description),
      qty: Math.max(0, num(o.qty)),
    };
  });
  const isoDate = ((): string | null => {
    const d = str(r.deliveryDate);
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  })();
  return {
    supplierName: str(r.supplierName),
    poNo: str(r.poNo),
    doNo: str(r.doNo),
    deliveryDate: isoDate,
    lines,
  };
}

// ONE Claude vision call for a delivery order. Mirrors callClaudeSlipExtract's
// transport (shared anthropicFetchWithRetry, 110s abort, temperature 0), with
// the GR prompt and no catalog prefix. `fewShotText` (optional) is injected
// after the system prompt as prior accepted extractions.
export async function callClaudeGrExtract(
  apiKey: string,
  fileBlocks: ContentBlock[],
  fewShotText: string,
): Promise<GrnExtractCall> {
  let errorMsg: string | null = null;
  let timedOut = false;
  let parsed: GrnExtracted | null = null;
  let claudeText = '';
  let cacheHit = false;

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
        // temperature=0 — deterministic OCR so a wrong read is a reproducible
        // bug, not a flaky lottery (same rule as the SO scanner).
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: GR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
              ...(fewShotText ? [{ type: 'text', text: fewShotText }] : []),
              ...fileBlocks,
              {
                type: 'text',
                text:
                  'Extract the delivery order above. OUTPUT FORMAT: your response must be VALID JSON ONLY, no preamble, no markdown fences. The first character must be "{" and the last "}".',
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
        cacheHit = (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0;
        const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
        claudeText = stripJsonFences(firstText);
        try {
          parsed = normalizeGrnExtract(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      timedOut = true;
      errorMsg = 'OCR timed out — the delivery order took too long to read. Please try again.';
    } else {
      errorMsg = `Network/fetch error: ${(e as Error).message}`;
    }
  }

  return { parsed, errorMsg, timedOut, claudeText, cacheHit };
}

// Few-shot pool for GR: the latest operator-reviewed delivery-order extractions
// (so_scan_samples.document_type='GR', status ACCEPTED/CONFIRMED). Best-effort:
// any query error or a missing table just yields '' (no examples). Kept small
// so the injected prompt stays cheap.
export async function loadGrnFewShot(svc: SupabaseClient): Promise<string> {
  try {
    const { data, error } = await svc
      .from('so_scan_samples')
      .select('extracted, corrected, status')
      .eq('document_type', 'GR')
      .in('status', ['ACCEPTED', 'CONFIRMED'])
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(5);
    if (error || !Array.isArray(data) || data.length === 0) return '';
    const examples = (data as Array<Record<string, unknown>>)
      .map((row) => (row.corrected ?? row.extracted))
      .filter((v) => v && typeof v === 'object')
      .map((v, i) => `EXAMPLE ${i + 1} (a delivery order previously read and confirmed correct):\n${JSON.stringify(v)}`);
    if (examples.length === 0) return '';
    return (
      'Here are past delivery orders read and confirmed by an operator. Use them to match this document\'s layout and coding conventions:\n\n' +
      examples.join('\n\n')
    );
  } catch {
    return '';
  }
}
