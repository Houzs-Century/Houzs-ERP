// ----------------------------------------------------------------------------
// scan-lorry-invoice.ts — read a workshop's quotation / invoice into the shape
// of a repair record (mig 0241), so the operator edits a filled form instead of
// retyping nineteen lines off a PDF.
//
// WHY IT IS A MINIMAL SIBLING, NOT A SECOND scan-so. scan-so.ts runs a durable
// background pipeline — a scan_jobs row, a Cloudflare Queue, a stale-job reaper,
// a per-salesperson learning loop — because a rep photographs a stack of slips
// on a phone with bad signal and must not lose one. A workshop invoice is one
// document, uploaded at a desk, and the operator is looking at the screen
// waiting for it. So this mirrors scan-payment.ts: ONE synchronous /extract, no
// job row, no queue, no learning. It EXTRACTS AND RETURNS — it writes nothing.
// Creating the work order stays the caller's explicit second step, because an
// OCR pass that silently books a RM22,208.50 repair is not something anyone
// asked for.
//
// HELPERS ARE INLINED, NOT IMPORTED, exactly as scan-payment.ts does it, so
// scan-so.ts's export surface does not widen for a second consumer.
//
// PDFs GO STRAIGHT IN. The document that prompted this (T FORCE AUTO SERVICES
// quotation WJO00403) is a PDF, and Anthropic takes PDFs as a `document` content
// block — so there is no rasteriser here and none is needed. Images are accepted
// too, for the phone-photo case.
//
// WHAT IT DOES NOT DO. It does not match the workshop to a scm.workshops row, it
// does not match the plate to a lorry, and it does not price anything. It
// returns what the paper says plus a confidence, and the review screen resolves
// those against the masters. An OCR pass must never invent an id.
//
// Route: POST /api/scm/scan-lorry-invoice/extract   (multipart, field `file`)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env } from '../../types';
import type { Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';

export const scanLorryInvoice = new Hono<{ Bindings: Env; Variables: Variables }>();
scanLorryInvoice.use('*', supabaseAuth);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** ArrayBuffer -> base64 (chunked; Workers have no Node Buffer). Inlined from
 *  scan-so.ts's toBase64 — kept private so scan-so's surface does not widen. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/** Claude sometimes wraps JSON in fences or adds a preamble — take the first `{`
 *  to the last `}`. Inlined verbatim from scan-so.ts's stripJsonFences. */
function stripJsonFences(text: string): string {
  let trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  return trimmed;
}

type AnthropicResponse = { content?: Array<{ type?: string; text?: string }>; error?: { message?: string } };

/** One billed line, as the paper prints it. */
export interface ExtractedRepairLine {
  section: 'PART' | 'LABOUR';
  lineNo: number | null;
  description: string;
  partNo: string | null;
  uom: string | null;
  qty: number | null;
  unitPriceRm: number | null;
  discountPct: number | null;
  /** The amount PRINTED on the line. Null when the document shows none. */
  amountRm: number | null;
}

export interface ExtractedRepairDoc {
  /** QUOTATION or INVOICE — which kind of paper this is. */
  docKind: 'QUOTATION' | 'INVOICE' | null;
  docNo: string | null;
  docDate: string | null;
  workshopName: string | null;
  workshopRegistrationNo: string | null;
  workshopAddress: string | null;
  workshopEmail: string | null;
  workshopPhone: string | null;
  advisor: string | null;
  plate: string | null;
  readyDate: string | null;
  lines: ExtractedRepairLine[];
  /** The GRAND TOTAL printed on the document — the cross-check, not a leg. */
  grandTotalRm: number | null;
  /** 0..1. Below ~0.6 the review screen should make the operator look. */
  confidence: number | null;
  /** Anything the model could not read or had to guess at. */
  warnings: string[];
}

const SYSTEM_PROMPT = `You read Malaysian workshop documents for a lorry fleet and return STRUCTURED JSON.

The document is a QUOTATION, a JOB ORDER or a TAX INVOICE from a motor workshop, for the repair or servicing of ONE commercial vehicle.

NEVER INVENT. Every value must be readable on the document. If a field is not there, return null. If you are guessing, say so in warnings and lower the confidence. A null is always better than a plausible fabrication — a wrong figure here becomes a wrong cost on a lorry.

NUMBERS ARE THE POINT. Never truncate or round a printed number. "1,100.00" is 1100 and "6,375.00" is 6375. Read every digit. Malaysian documents use a comma thousands separator and a dot decimal.

LINE SECTIONS. These documents group lines under headings such as "Part Charges", "Labour Charges", "Service Charges", "Parts", "Labour". Emit section "LABOUR" for any line under a labour/service/workmanship heading, and "PART" for everything else. When there is no heading at all, use "PART". Line numbering usually RESTARTS in each section — keep the number the document prints, in lineNo.

PER-LINE DISCOUNT. A column headed "Dis.%", "Disc", "Disc %" or similar is a PERCENTAGE off that line, not an amount and not a document-level discount. A blank means no discount — return null, never 0 guessed from nowhere. The printed Amount normally equals Qty x Unit Price x (1 - Dis%/100); report all four as printed and do NOT recompute the amount yourself.

UOM. Copy the unit exactly as printed (PC, UNIT, SET, LIT, NOS, HR, ...). Uppercase it. Null when the column is blank.

PLATE. The vehicle registration, usually labelled "Vehicle", "Reg No" or "No. Pendaftaran". Return it with no spaces, uppercased.

WORKSHOP IDENTITY. The workshop is the party ISSUING the document (its letterhead), NOT the "To:" / "Bill To:" party — that one is our own company. Take its name, SSM / company registration number (a 12-digit number like 202501030334, or an older style like 123456-A), address, email and phone from the letterhead.

DATES. Return ISO YYYY-MM-DD. Malaysian documents are DAY/MONTH/YEAR — "15/7/2026" is 2026-07-15, never 2026-15-07. A "Ready Date" that reads "Ready", "TBA" or similar is not a date; return null for readyDate and note it in warnings.

GRAND TOTAL. Return the total the document PRINTS. Do not compute it. It is the cross-check against the lines.

OUTPUT
======
{
  "docKind": "QUOTATION" | "INVOICE" | null,
  "docNo": string | null,
  "docDate": "YYYY-MM-DD" | null,
  "workshopName": string | null,
  "workshopRegistrationNo": string | null,
  "workshopAddress": string | null,
  "workshopEmail": string | null,
  "workshopPhone": string | null,
  "advisor": string | null,
  "plate": string | null,
  "readyDate": "YYYY-MM-DD" | null,
  "lines": [
    {
      "section": "PART" | "LABOUR",
      "lineNo": number | null,
      "description": string,
      "partNo": string | null,
      "uom": string | null,
      "qty": number | null,
      "unitPriceRm": number | null,
      "discountPct": number | null,
      "amountRm": number | null
    }
  ],
  "grandTotalRm": number | null,
  "confidence": number,
  "warnings": [string]
}`;

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
};
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  /* The model is told to send numbers, but a "1,100.00" slips through often
     enough that stripping separators here is cheaper than a re-ask. */
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s && ISO_DATE.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
};

/** Coerce whatever came back into ExtractedRepairDoc. Defensive throughout:
 *  the model occasionally omits a field or returns the wrong primitive, and a
 *  throw here would lose an extraction the operator already paid for. */
export function normalizeDoc(raw: unknown): ExtractedRepairDoc {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rawLines = Array.isArray(o.lines) ? o.lines : [];
  const lines: ExtractedRepairLine[] = rawLines.map((l) => {
    const r = (l ?? {}) as Record<string, unknown>;
    const section: 'PART' | 'LABOUR' = String(r.section ?? 'PART').toUpperCase() === 'LABOUR' ? 'LABOUR' : 'PART';
    const pct = numOrNull(r.discountPct);
    return {
      section,
      lineNo: numOrNull(r.lineNo),
      description: str(r.description) ?? '',
      partNo: str(r.partNo),
      uom: str(r.uom)?.toUpperCase() ?? null,
      qty: numOrNull(r.qty),
      unitPriceRm: numOrNull(r.unitPriceRm),
      /* Out-of-range is dropped, not clamped: a "150%" discount means the
         column was misread, and silently making it 100% would zero the line. */
      discountPct: pct != null && pct >= 0 && pct <= 100 ? pct : null,
      amountRm: numOrNull(r.amountRm),
    };
  }).filter((l) => l.description || l.amountRm != null);

  const kindRaw = String(o.docKind ?? '').toUpperCase();
  const conf = numOrNull(o.confidence);
  return {
    docKind: kindRaw === 'QUOTATION' || kindRaw === 'INVOICE' ? kindRaw : null,
    docNo: str(o.docNo),
    docDate: dateOrNull(o.docDate),
    workshopName: str(o.workshopName),
    workshopRegistrationNo: str(o.workshopRegistrationNo),
    workshopAddress: str(o.workshopAddress),
    workshopEmail: str(o.workshopEmail),
    workshopPhone: str(o.workshopPhone),
    advisor: str(o.advisor),
    plate: str(o.plate)?.replace(/\s+/g, '').toUpperCase() ?? null,
    readyDate: dateOrNull(o.readyDate),
    lines,
    grandTotalRm: numOrNull(o.grandTotalRm),
    confidence: conf != null ? Math.min(1, Math.max(0, conf)) : null,
    warnings: Array.isArray(o.warnings) ? o.warnings.map((w) => String(w)).filter(Boolean) : [],
  };
}

const rmToCenti = (rm: number | null): number | null => (rm == null ? null : Math.round(rm * 100));

/** What one line costs, from what was extracted. Same precedence the stored
 *  record uses (services/fleet-status.ts workOrderLineCenti): a printed amount
 *  wins, else qty x unit x (1 - disc). Duplicated rather than imported because
 *  that module is DB-row shaped and this one is document shaped; the two are
 *  kept honest by the reconciliation below, which fails loudly on a drift. */
export function lineCenti(l: ExtractedRepairLine): number {
  if (l.amountRm != null) return Math.max(0, Math.round(l.amountRm * 100));
  const gross = (l.qty ?? 0) * (l.unitPriceRm ?? 0) * 100;
  const pct = l.discountPct ?? 0;
  return Math.max(0, Math.round(gross * (1 - pct / 100)));
}

/** Does the sum of the lines match the total the document prints?
 *
 *  This is the single most valuable check in the whole endpoint. An OCR pass
 *  that drops one line of nineteen produces a record that looks perfectly
 *  plausible and is quietly wrong by RM6,375. Comparing against a number the
 *  model read from a DIFFERENT part of the page catches exactly that, and it
 *  costs nothing.
 *
 *  One sen of slack per line absorbs the vendor's own rounding without letting
 *  a missing line through. */
export function reconcile(doc: ExtractedRepairDoc): { linesCenti: number; printedCenti: number | null; matches: boolean | null; deltaCenti: number | null } {
  const linesCenti = doc.lines.reduce((s, l) => s + lineCenti(l), 0);
  const printedCenti = rmToCenti(doc.grandTotalRm);
  if (printedCenti == null) return { linesCenti, printedCenti: null, matches: null, deltaCenti: null };
  const delta = linesCenti - printedCenti;
  return { linesCenti, printedCenti, matches: Math.abs(delta) <= Math.max(1, doc.lines.length), deltaCenti: delta };
}

// ── POST /extract ────────────────────────────────────────────────────────────
scanLorryInvoice.post('/extract', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'anthropic_key_missing', reason: 'Document reading is not configured on this environment.' }, 503);
  }

  let form: FormData;
  try { form = await c.req.formData(); } catch {
    return c.json({ error: 'invalid_upload', reason: 'Could not read the uploaded file.' }, 400);
  }

  const file = form.getAll('file').find((f): f is File => f instanceof File && f.size > 0)
    ?? [...form.values()].find((f): f is File => f instanceof File && f.size > 0);
  if (!file) return c.json({ error: 'file_required', reason: 'Attach the workshop document.' }, 400);
  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: 'file_too_large', reason: `"${file.name}" is over 20MB.` }, 400);
  }

  const name = (file.name || '').toLowerCase();
  const mime = file.type || '';
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  const isImage = IMAGE_MIMES.has(mime) || /\.(jpe?g|png|webp)$/.test(name);
  if (!isPdf && !isImage) {
    return c.json({ error: 'unsupported_file', reason: `Unsupported file type "${file.name}". Use PDF / JPEG / PNG / WEBP.` }, 400);
  }

  const data = toBase64(await file.arrayBuffer());
  const fileBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: (IMAGE_MIMES.has(mime) ? mime
            : name.endsWith('.png') ? 'image/png'
            : name.endsWith('.webp') ? 'image/webp'
            : 'image/jpeg') as string,
          data,
        },
      };

  let parsed: ExtractedRepairDoc | null = null;
  let errorMsg: string | null = null;

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      /* One document, one shot, an operator waiting. 110s matches scan-so's
         own ceiling and sits under the frontend's 120s scan allowance. */
      signal: AbortSignal.timeout(110_000),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: SYSTEM_PROMPT },
            fileBlock,
            {
              type: 'text',
              text: 'Extract the workshop document above using the rules. '
                + "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, or chain-of-thought. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'.",
            },
          ],
        }],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 300)}`;
    } else {
      let r: AnthropicResponse = {};
      try { r = JSON.parse(bodyText) as AnthropicResponse; } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 200)}`;
      }
      const text = (r.content ?? []).find((b) => b.type === 'text')?.text ?? '';
      if (!errorMsg && !text) errorMsg = r.error?.message ?? 'The reader returned nothing.';
      if (!errorMsg) {
        try { parsed = normalizeDoc(JSON.parse(stripJsonFences(text))); } catch {
          errorMsg = 'The reader did not return usable JSON.';
        }
      }
    }
  } catch (e) {
    errorMsg = e instanceof Error && e.name === 'TimeoutError'
      ? 'Reading the document took too long. Try a smaller file.'
      : `Could not reach the reader: ${e instanceof Error ? e.message : 'unknown error'}`;
  }

  if (!parsed) return c.json({ error: 'extract_failed', reason: errorMsg ?? 'Could not read the document.' }, 502);

  const check = reconcile(parsed);
  return c.json({
    document: parsed,
    /* Everything below is DERIVED for the review screen. The record is not
       written here — the operator confirms first. */
    totals: {
      linesCenti: check.linesCenti,
      printedTotalCenti: check.printedCenti,
      /* null = the document printed no total, so there was nothing to check
         against. That is not the same as "checked and agreed". */
      reconciles: check.matches,
      deltaCenti: check.deltaCenti,
    },
    lines: parsed.lines.map((l) => ({
      section: l.section,
      lineNo: l.lineNo,
      name: l.description,
      partNo: l.partNo,
      uom: l.uom,
      qty: l.qty,
      unitPriceCenti: rmToCenti(l.unitPriceRm),
      discountPct: l.discountPct,
      amountCenti: rmToCenti(l.amountRm),
      lineCenti: lineCenti(l),
    })),
  });
});

export default scanLorryInvoice;
