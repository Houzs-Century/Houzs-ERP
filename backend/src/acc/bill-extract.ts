// ----------------------------------------------------------------------------
// bill-extract — read an incoming BILL (utility, rent, supplier invoice…) with
// Claude vision and hand back the fields a Payment Voucher wants pre-filled.
//
// The owner's ask (2026-09-02): 我想要把ocr 功能放去payment 那边，还有coming 的
// bill 我也想要用ocr. Three upload shapes, HIS taxonomy: one bill of several
// pages (the caller sends those files as ONE bill), one supplier's several
// bills, many suppliers' many bills — this module reads ONE BILL PER CALL
// ENTRY and never guesses whether two files are one document; that grouping
// is decided by a human at upload time.
//
// Discipline copied from scan-so (the production OCR this repo already runs):
//   • the model returns STRICT JSON, unreadable fields are null — never
//     invented;
//   • amounts come back in RM and are converted to integer sen HERE, once;
//   • matching free text to SYSTEM entities (the supplier) happens SERVER-side
//     in plain code, not in the prompt — the model reads what is printed, the
//     code decides what it maps to.
//
// NOTHING here writes. The voucher is still typed, checked and saved by a
// person; the approval cycle is untouched. This module only reads paper.
// ----------------------------------------------------------------------------

/* The image allowlist lives in vision-blocks.ts — ONE home for "what images
   can Claude read here", shared with the assistant and the scan routes. */
import { ASSISTANT_IMAGE_MIMES as BILL_IMAGE_MIMES } from '../services/vision-blocks';

export { BILL_IMAGE_MIMES };

/* Same pinned model as scan-so — one vision model per repo, so prompt-cache
   behaviour and quality drift are reasoned about in one place. */
export const BILL_MODEL = 'claude-sonnet-4-6';

export const MAX_BILL_FILE_BYTES = 20 * 1024 * 1024; // scan-so's cap
export const MAX_BILLS_PER_CALL = 12;
export const MAX_FILES_PER_BILL = 8;

export type BillFile = { name: string; mime: string; dataBase64: string };

export type BillLine = { description: string | null; amountSen: number | null };

export type BillExtraction = {
  vendorName: string | null;
  vendorRegNo: string | null;
  documentKind: 'invoice' | 'bill' | 'receipt' | 'statement' | 'unknown';
  invoiceNumber: string | null;
  invoiceDate: string | null;   // ISO yyyy-mm-dd, null when unreadable
  dueDate: string | null;
  currency: string;             // 'MYR' unless the paper clearly says otherwise
  totalSen: number | null;
  sstSen: number | null;
  lines: BillLine[];
};

const PROMPT = `You are reading ONE incoming bill/invoice for a Malaysian furniture company's finance clerk. The input images/PDF pages all belong to THIS ONE document.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "vendorName": the issuing company's name as PRINTED (the party asking to be paid) or null,
  "vendorRegNo": the issuer's registration number (e.g. 202301027399, 1234567-X) or null,
  "documentKind": one of "invoice" | "bill" | "receipt" | "statement" | "unknown",
  "invoiceNumber": the document's own number or null,
  "invoiceDate": the document date as YYYY-MM-DD or null,
  "dueDate": the payment due date as YYYY-MM-DD or null,
  "currency": the 3-letter currency printed (default "MYR"),
  "totalRm": the GRAND TOTAL payable as a plain number (e.g. 1234.56) or null,
  "sstRm": the SST/tax amount as a plain number, or null when not itemised,
  "lines": up to 8 entries [{ "description": string, "amountRm": number|null }] — the bill's own line items, or ONE entry summarising the charge when the bill has no itemisation
}

Rules:
- Read what is PRINTED. A field you cannot read with confidence is null — NEVER estimated, NEVER computed from other fields.
- Dates: Malaysian papers usually print DD/MM/YYYY — convert to YYYY-MM-DD. A date you cannot disambiguate is null.
- totalRm is the amount the vendor asks to be PAID (after tax/rounding), not a subtotal.
- vendorName is the ISSUER, never the addressee (the addressee is our own company).
- Line descriptions stay short (under 80 chars), in the bill's own words.`;

const rmToSen = (v: unknown): number | null => {
  /* null / undefined / '' are ABSENT, not zero — Number(null) is 0, and a
     bill whose total the model could not read must never arrive as RM 0.00. */
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

const isoOrNull = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Coerce whatever the model said into the strict shape — every field
    defensively, because a vision model under a bad photo says strange things
    and NONE of them may crash a finance screen. */
export function coerceBillJson(raw: unknown): BillExtraction {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kindRaw = String(o.documentKind ?? '').toLowerCase();
  const kind = (['invoice', 'bill', 'receipt', 'statement'] as const).find((k) => k === kindRaw) ?? 'unknown';
  const linesRaw = Array.isArray(o.lines) ? o.lines : [];
  return {
    vendorName: o.vendorName ? String(o.vendorName).slice(0, 200) : null,
    vendorRegNo: o.vendorRegNo ? String(o.vendorRegNo).slice(0, 60) : null,
    documentKind: kind,
    invoiceNumber: o.invoiceNumber ? String(o.invoiceNumber).slice(0, 80) : null,
    invoiceDate: isoOrNull(o.invoiceDate),
    dueDate: isoOrNull(o.dueDate),
    currency: /^[A-Za-z]{3}$/.test(String(o.currency ?? '')) ? String(o.currency).toUpperCase() : 'MYR',
    totalSen: rmToSen(o.totalRm),
    sstSen: rmToSen(o.sstRm),
    lines: linesRaw.slice(0, 8).map((l) => {
      const li = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
      return {
        description: li.description ? String(li.description).slice(0, 160) : null,
        amountSen: rmToSen(li.amountRm),
      };
    }),
  };
}

/* The model sometimes wraps JSON in prose or a fence — take the outermost
   object, the same tolerance scan-so ships. */
export function parseModelJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** ONE bill → one vision call. fetchImpl is injectable so tests never touch
    the network. Throws only on programmer error; API trouble comes back as
    { ok: false, reason } for the route to say out loud. */
export async function extractOneBill(
  apiKey: string,
  files: BillFile[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; extraction: BillExtraction } | { ok: false; reason: string }> {
  const blocks = files.map((f) => (
    BILL_IMAGE_MIMES.has(f.mime)
      ? { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.dataBase64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.dataBase64 } }
  ));
  let res: Response;
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: BILL_MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: PROMPT }] }],
      }),
    });
  } catch (e) {
    return { ok: false, reason: `The reader could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `The reader refused (${res.status}): ${body.slice(0, 200)}` };
  }
  /* A 200 whose body is not JSON is still a refusal worth naming, not an
     empty extraction. */
  let data: { content?: Array<{ type: string; text?: string }> };
  try {
    data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  } catch (e) {
    return { ok: false, reason: `The reader's answer was unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const parsed = parseModelJson(text);
  if (!parsed) return { ok: false, reason: 'The reader answered, but not with a bill — try a clearer photo.' };
  return { ok: true, extraction: coerceBillJson(parsed) };
}

/* ── Supplier fuzzy match — server-side, plain code ─────────────────────────
   Normalise both sides (case, punctuation, the SDN BHD / S/B / ENTERPRISE
   tails every Malaysian company name drags around) and score:
   exact normalized = 1, one contains the other = 0.8. Below that, no match —
   a wrong supplier pre-selected is worse than none. */
export const normalizeVendor = (s: string): string =>
  s.toUpperCase()
    .replace(/\b(SDN\.?\s*BHD\.?|BHD\.?|S\/B|PLT|ENTERPRISE|TRADING|COMPANY|CO\.?)\b/g, ' ')
    .replace(/[^A-Z0-9一-鿿]+/g, ' ')
    .trim().replace(/\s+/g, ' ');

export type SupplierRow = { id: string; code: string | null; name: string };

export function matchSupplier(
  vendorName: string | null,
  suppliers: SupplierRow[],
): { supplier: SupplierRow; confidence: 'exact' | 'contains' } | null {
  if (!vendorName) return null;
  const v = normalizeVendor(vendorName);
  if (!v) return null;
  for (const s of suppliers) {
    if (normalizeVendor(s.name) === v) return { supplier: s, confidence: 'exact' };
  }
  for (const s of suppliers) {
    const n = normalizeVendor(s.name);
    if (n && (n.includes(v) || v.includes(n))) return { supplier: s, confidence: 'contains' };
  }
  return null;
}
