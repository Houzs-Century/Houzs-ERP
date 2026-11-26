
import { Hono, type Context } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId } from '../lib/companyScope';
import type { Env, Variables } from '../env';
import {
  loadPaymentOptions,
  snapPaymentOption,
  type PaymentOptionCategory as OptionCategory,
  type CatalogOptions,
} from '../lib/payment-vocab';
import { getBranding } from '../../services/branding';
import { recordAi, requestAiTag } from '../../services/aiUsage';
import { slipBindings, expiresInOneHour } from '../lib/slip';
import { buildSlipKey, type SlipMime } from '../lib/r2';
import { scanTimer } from '../lib/scan-timing';
import { keepScanFile } from '../lib/scan-files';
import { aiReadEnqueue, aiReadPoll, type AiReadSplit } from '../lib/ai-read-jobs';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanPayment = new Hono<{ Bindings: Env; Variables: Variables }>();
scanPayment.use('*', supabaseAuth);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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

function stripJsonFences(text: string): string {
  let trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

function formatOptions(o: CatalogOptions): string {
  const lines: string[] = [];
  const section = (title: string, cat: OptionCategory) => {
    lines.push(`=== ${title} (allowed values: value | label) ===`);
    const rows = o[cat];
    if (rows.length === 0) lines.push('—');
    for (const r of rows) lines.push(`${r.value} | ${r.label}`);
    lines.push('');
  };
  section('PAYMENT METHODS',   'payment_method');
  section('MERCHANT BANKS',    'payment_merchant');
  section('ONLINE TYPES',      'online_type');
  section('INSTALLMENT PLANS', 'installment_plan');
  return lines.join('\n').trimEnd();
}

const buildSystemPrompt = (companyName: string) => `You read a single MALAYSIAN bank CARD-TERMINAL / payment receipt and extract the payment fields for ONE payment row at ${companyName}, a Malaysian furniture retailer. The image is usually a thermal card-machine slip (Maybank / CIMB / Public Bank / HLB / RHB / AEON terminal), an EPP (Easy Payment Plan / installment) approval slip, a DuitNow / bank-transfer / e-wallet (Touch 'n Go) confirmation, a cheque, or a cash receipt.

A reference list of ALLOWED VALUES follows this prompt (PAYMENT METHODS, MERCHANT BANKS, ONLINE TYPES, INSTALLMENT PLANS). Each row is "value | label". Every *Match you return MUST be the VALUE (left side), copied character-for-character from the list. NEVER invent a value outside the list; when you cannot find a defensible match, return null for that field.

PAYMENT METHODS are exactly THREE: Merchant, Online, Cash. There is NO "Installment" method — a bank EPP / installment receipt is recorded as Method = Merchant with the tenure carried in installmentPlanMatch.

Extract EXACTLY what is printed on the receipt. Do NOT "correct", reconcile, or recompute any figure, and do NOT derive or sum a TOTAL the receipt does not itself print — read the printed TOTAL / amount as-is, never compute it from a monthly repayment × tenure or from line items. If a field is genuinely absent, return null — never guess a value the receipt does not show.

When a field is genuinely AMBIGUOUS (a smudged digit, two equally-plausible readings, an unclear amount/date/tenure), do NOT confidently pick one — return your single best guess at LOWER confidence (below 0.6) and state the ambiguity in that field's "reason" so the operator reviews it. A flagged low-confidence guess the operator catches beats a confident wrong value that slips through.

HOW TO CLASSIFY THE RECEIPT
===========================
Decide the top-level method (paymentMethodMatch — one of PAYMENT METHODS):

1. ANY CARD-TERMINAL receipt — a normal swipe ("SALE" / "APPROVED") OR an EPP / installment approval (a "TENURE", "06 MONTHS" / "6 MTHS", "MONTHLY REPAYMENT" / "MONTHLY INSTALMENT" line, the words "EPP" / "EASY PAYMENT PLAN" / "INSTALMENT" / "ANSURAN" / "IPP", a plan code with a month count) → method = the "Merchant" value. Then:
     • bankMatch.value = the HOST / acquirer / terminal bank from MERCHANT BANKS. Read the "HOST", acquirer, or terminal-bank line (Maybank "Host: MBB" → the MBB value; Public Bank → the Public value; CIMB → CIMB; Hong Leong → HLB; RHB → RHB; an AEON terminal → the AEON value). If the host bank is NOT a row in MERCHANT BANKS, return bankMatch = null (leave it blank for a manual pick — do NOT substitute a different bank).
     • installmentPlanMatch.value = the tenure plan from INSTALLMENT PLANS. If the receipt prints a tenure ("TENURE 06 MONTHS" / "6 MTHS" / "12 Months" / IPP 12) → the matching N-month value (06 → the 6-month value, 12 → the 12-month value). If the receipt shows NO tenure / months at all (a plain swipe) → the "One Shot" / one-off plan value (the no-months / single-payment entry in INSTALLMENT PLANS). Always set installmentPlanMatch for a Merchant receipt (One Shot when no tenure is printed). NEVER default to a 12-month (or any N-month) value when no tenure / month count is printed — a card receipt with no tenure is One Shot, even when it prints "EPP" / "EASY PAYMENT PLAN" / "INSTALMENT" / "ANSURAN" / "IPP" with NO number. Only set an N-month value when an actual month count is written on the receipt.

2. DUITNOW / BANK TRANSFER / TOUCH 'N GO (TNG) / E-WALLET / CHEQUE → method = the "Online" value, and set onlineTypeMatch to the matching ONLINE TYPES value (DuitNow → the DuitNow value, an IBG/instant transfer → the Bank Transfer value, Touch 'n Go / TNG → the TNG value, a cheque → the Cheque value). bankMatch and installmentPlanMatch = null.

3. CASH receipt → method = the "Cash" value. All other matches = null.

FIELDS
======
- paymentMethodMatch — the method value chosen by the rules above (Merchant / Online / Cash only).
- bankMatch — a MERCHANT BANKS value: the HOST / acquirer bank. ONLY meaningful when the method is Merchant (rule 1). null when the method is Online/Cash OR when the host bank is not in the list.
- onlineTypeMatch — an ONLINE TYPES value. ONLY meaningful when the method is Online (rule 2). Leave null otherwise.
- installmentPlanMatch — an INSTALLMENT PLANS value (the tenure). For a Merchant receipt this is the printed tenure, or the "One Shot" / one-off value when no tenure is printed. NEVER default to 12 months (or any N-month value) when no month count is on the receipt — no tenure printed means One Shot. null when the method is Online/Cash.
- approvalCode — the receipt's "APPROVAL CODE" / "APPROVAL NO" / "APPR CODE" / "APPR" / "AUTH CODE" / "KOD KELULUSAN", as the bare alphanumeric string (e.g. "APPROVAL CODE 073496" → "073496"). Strip labels/brackets. null when absent.
- amountRm — the charged TOTAL as a NUMBER in RM: the "TOTAL", "CARD TOTAL", "AMOUNT", "JUMLAH", or "SALE AMOUNT" the customer was charged (e.g. "RM 4,600.00" → 4600; "TOTAL RM 1,500.00" → 1500). For an EPP receipt this is the full financed amount (the TOTAL), NOT the monthly repayment. null when no total is readable.
- paidAt — the receipt's own SWIPE / transaction DATE as "YYYY-MM-DD". Read the printed DATE/TIME on the receipt (e.g. "DATE 22/06/26 14:03" → "2026-06-22"). THIS MAY BE A PAST DATE — the receipt date is days before the slip is scanned; use the printed date, NEVER today's date. Two-digit years are 20YY. null when no date is readable.

Each *Match returns { "value": <exact list value>, "confidence": 0-1, "reason": <short why> } or null. Use confidence 0.9+ only when the receipt clearly identifies one specific list row; 0.5-0.8 when plausible but ambiguous; below 0.5 prefer null.

Example A — a Maybank swipe "Host: MBB", no tenure, "APPR 073496", "TOTAL RM 4,600.00", "DATE 22/06/26": paymentMethodMatch.value = the Merchant value, bankMatch.value = the MBB value, installmentPlanMatch.value = the One Shot / one-off value, onlineTypeMatch = null, approvalCode = "073496", amountRm = 4600, paidAt = "2026-06-22".
Example B — an AEON EPP slip with "TENURE 12 MONTHS", "APPROVAL CODE 046501", "TOTAL RM 1,500.00", "DATE 20/06/26": paymentMethodMatch.value = the Merchant value, bankMatch.value = the AEON value (if AEON is in MERCHANT BANKS; else null), installmentPlanMatch.value = the 12-month value, onlineTypeMatch = null, approvalCode = "046501", amountRm = 1500, paidAt = "2026-06-20".
Example C — a DuitNow transfer confirmation for RM 550.50 dated 19 Jun 2026: paymentMethodMatch.value = the Online value, onlineTypeMatch.value = the DuitNow value, bankMatch = null, installmentPlanMatch = null, approvalCode = null (unless a reference number is clearly an approval code), amountRm = 550.5, paidAt = "2026-06-19".

OUTPUT
======
Return STRICT JSON, no markdown fences, no prose:
{
  "paymentMethodMatch":   { "value": string, "confidence": number, "reason": string } | null,
  "bankMatch":            { "value": string, "confidence": number, "reason": string } | null,
  "onlineTypeMatch":      { "value": string, "confidence": number, "reason": string } | null,
  "installmentPlanMatch": { "value": string, "confidence": number, "reason": string } | null,
  "approvalCode": string | null,
  "amountRm": number | null,
  "paidAt": string | null
}`;

type OptionMatch = { value: string; confidence: number; reason: string };
type ExtractedReceipt = {
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  approvalCode: string | null;
  amountRm: number | null;
  paidAt: string | null;
};

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
};

type Warning = { field: string; value: string; message: string };

function normalizeReceipt(raw: unknown): ExtractedReceipt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const isoDate = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [, y, mo, d] = m;
    const month = Number(mo); const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y}-${mo}-${d}`;
  };
  const optionMatch = (v: unknown): OptionMatch | null => {
    if (!v || typeof v !== 'object') return null;
    const m = v as Record<string, unknown>;
    const value = typeof m.value === 'string' && m.value.trim() !== ''
      ? m.value
      : typeof m.code === 'string' && m.code.trim() !== '' ? m.code : null;
    if (value === null) return null;
    return {
      value,
      confidence: typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0,
      reason: typeof m.reason === 'string' ? m.reason : '',
    };
  };
  return {
    paymentMethodMatch:   optionMatch(r.paymentMethodMatch),
    bankMatch:            optionMatch(r.bankMatch),
    onlineTypeMatch:      optionMatch(r.onlineTypeMatch),
    installmentPlanMatch: optionMatch(r.installmentPlanMatch),
    approvalCode:         str(r.approvalCode),
    amountRm:             num(r.amountRm),
    paidAt:              isoDate(r.paidAt),
  };
}

function validateReceipt(rec: ExtractedReceipt, options: CatalogOptions): Warning[] {
  const warnings: Warning[] = [];
  const fields: Array<{
    field: keyof Pick<ExtractedReceipt,
      'paymentMethodMatch' | 'bankMatch' | 'onlineTypeMatch' | 'installmentPlanMatch'>;
    category: OptionCategory;
  }> = [
    { field: 'paymentMethodMatch',   category: 'payment_method' },
    { field: 'bankMatch',            category: 'payment_merchant' },
    { field: 'onlineTypeMatch',      category: 'online_type' },
    { field: 'installmentPlanMatch', category: 'installment_plan' },
  ];
  for (const { field, category } of fields) {
    const m = rec[field];
    if (!m) continue;
    const hit = snapPaymentOption(options[category], m.value);
    if (hit) {
      m.value = hit;
    } else {
      warnings.push({
        field,
        value: m.value,
        message: `Suggested ${category.replace(/_/g, ' ')} not in the active list — cleared.`,
      });
      rec[field] = null;
    }
  }
  return warnings;
}

type SlipPersistResult =
  | { ok: true; uploadSessionId: string; slipKey: string }
  | { ok: false; error: string };

async function persistReceiptAsSlip(
  c: { env: Env },
  sb: SupabaseClient,
  staffId: string,
  buf: ArrayBuffer,
  mime: SlipMime,
  companyId: number | null,
): Promise<SlipPersistResult> {
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch { return { ok: false, error: 'r2_not_configured' }; }

  let roomQ = sb
    .from('showrooms')
    .select('id')
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .limit(1);
  if (companyId != null) roomQ = roomQ.eq('company_id', companyId);
  const { data: defaultRoom, error: roomErr } = await roomQ.maybeSingle();
  if (roomErr) return { ok: false, error: 'showroom_lookup_failed' };
  const showroomId = (defaultRoom as { id?: string } | null)?.id ?? null;

  const sessionId = crypto.randomUUID();
  const slipKey = buildSlipKey(sessionId, mime);

  const digest = await crypto.subtle.digest('SHA-256', buf);
  const contentHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    await bindings.bucket.put(slipKey, buf, { httpMetadata: { contentType: mime } });
  } catch {
    return { ok: false, error: 'r2_put_failed' };
  }

  const { error: insertErr } = await sb.from('pending_slip_uploads').insert({
    company_id: companyId ?? null,
    id: sessionId,
    upload_session_id: sessionId,
    staff_id: staffId,
    showroom_id: showroomId,
    r2_key: slipKey,
    content_type: mime,
    content_hash: contentHash,
    content_size: buf.byteLength,
    status: 'uploaded',
    expires_at: expiresInOneHour(),
  });
  if (insertErr) {
    await bindings.bucket.delete(slipKey).catch(() => {});
    return { ok: false, error: 'db_insert_failed' };
  }

  return { ok: true, uploadSessionId: sessionId, slipKey };
}

export const extractPaymentHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> => {
  const timer = scanTimer('payment');
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'anthropic_key_missing', reason: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' },
      503,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json({ error: 'bad_request', reason: `Invalid multipart body: ${(e as Error).message}` }, 400);
  }

  let file: File | null = null;
  for (const [, v] of formData.entries() as Iterable<[string, unknown]>) {
    if (v instanceof File && v.size > 0) { file = v; break; }
  }
  if (!file) {
    return c.json({ error: 'bad_request', reason: 'No file uploaded.' }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      { error: 'bad_request', reason: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` },
      400,
    );
  }

  const mime = file.type || '';
  const name = (file.name || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  const isImage =
    IMAGE_MIMES.has(mime) ||
    name.endsWith('.jpg') || name.endsWith('.jpeg') ||
    name.endsWith('.png') || name.endsWith('.webp');
  if (!isPdf && !isImage) {
    return c.json(
      { error: 'bad_request', reason: `Unsupported file type "${mime || name}". Use JPEG / PNG / WEBP / PDF.` },
      400,
    );
  }

  const buf = await file.arrayBuffer();
  // HC-0006: keep the original + its scan_files row, started with the read so it adds no wait; a
  // failed read still leaves both.
  const kept = keepScanFile(c.env, c.get('supabase'), {
    kind: 'payment', companyId: activeCompanyId(c), buf, mime: mime || (isPdf ? 'application/pdf' : 'image/jpeg'),
    uploadedBy: (c.get('user') as { id?: string } | undefined)?.id ?? null, key: null,
  });
  timer.mark('upload');
  const data = toBase64(buf);
  const slipMime: SlipMime = isPdf
    ? 'application/pdf'
    : IMAGE_MIMES.has(mime)
      ? (mime as SlipMime)
      : name.endsWith('.png') ? 'image/png'
      : name.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg';
  type ContentBlock = Record<string, unknown>;
  const fileBlock: ContentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: IMAGE_MIMES.has(mime)
            ? mime
            : name.endsWith('.png') ? 'image/png'
            : name.endsWith('.webp') ? 'image/webp'
            : 'image/jpeg',
          data,
        },
      };

  const sb = c.get('supabase');
  const { options } = await loadPaymentOptions(sb, activeCompanyId(c) ?? null);
  const optionsText = formatOptions(options);

  const branding = await getBranding(c.env);
  const systemPrompt = buildSystemPrompt(branding.companyName);
  timer.mark('prep');

  let errorMsg: string | null = null;
  let parsed: ExtractedReceipt | null = null;
  let claudeText = '';
  const usage = requestAiTag(c, 'scan_payment', CLAUDE_MODEL);

  try {
    const resp = await recordAi(usage, fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${systemPrompt}\n\nALLOWED VALUES\n==============\n${optionsText}` },
              fileBlock,
              {
                type: 'text',
                text:
                  'Extract the payment receipt above using the rules + allowed values. ' +
                  "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, or chain-of-thought. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'.",
              },
            ],
          },
        ],
      }),
    }));

    const bodyText = await resp.text();
    timer.mark('model');
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
          parsed = normalizeReceipt(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }
  await kept;

  if (!parsed) {
    timer.done(c.env, null, 'error');
    return c.json({ error: 'extract_failed', reason: errorMsg ?? 'Extraction failed.' }, 502);
  }

  const warnings = validateReceipt(parsed, options);
  timer.mark('parse');

  let slip: SlipPersistResult;
  try {
    const staffId = (c.get('user') as { id: string }).id;
    slip = await persistReceiptAsSlip(c, sb, staffId, buf, slipMime, activeCompanyId(c) ?? null);
  } catch (e) {
    slip = { ok: false, error: (e as Error).message || 'slip_persist_failed' };
  }
  if (!slip.ok) {
    // eslint-disable-next-line no-console
    console.warn('[scan-payment] receipt not kept as slip:', slip.error);
  }
  timer.mark('save');
  timer.done(c.env, null, 'ok');

  return c.json({
    success: true,
    data: {
      extracted: parsed,
      warnings,
      slipKey: slip.ok ? slip.slipKey : null,
      uploadSessionId: slip.ok ? slip.uploadSessionId : null,
      slipError: slip.ok ? null : slip.error,
    },
  });
};
scanPayment.post('/extract', extractPaymentHandler);

const firstReceipt: AiReadSplit = async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return { ok: false, resp: c.json({ error: 'bad_request', reason: `Invalid multipart body: ${(e as Error).message}` }, 400) };
  }
  for (const [, v] of formData.entries() as Iterable<[string, unknown]>) {
    if (v instanceof File && v.size > 0) {
      return { ok: true, bodies: [{}], file: { bytes: await v.arrayBuffer(), name: v.name || 'receipt', type: v.type || '' } };
    }
  }
  return { ok: false, resp: c.json({ error: 'bad_request', reason: 'No file uploaded.' }, 400) };
};
scanPayment.post('/extract/enqueue', aiReadEnqueue('pay_extract', () => true, firstReceipt));
scanPayment.get('/extract/jobs', aiReadPoll('pay_extract', () => true));

export default scanPayment;
