// ---------------------------------------------------------------------------
// pi-scan-ai-match — the last try for invoice rows the rules could not tie (owner
// 2026-11-09: "if it's similar it should AI-match"). ONE text call per invoice:
// the printed rows still untied and the supplier's open SKUs; the model names the
// best SKU per row, or none, with a confidence. Only a high-confidence answer
// naming a SKU we sent, of the size the row prints, is kept, and it reaches the
// check screen marked "AI match, please check". No key, a failed call or an
// unreadable answer leaves the rows as they were, never an error.
// ---------------------------------------------------------------------------

import type { Env } from '../env';
import { recordAi, type AiUsageTag } from '../../services/aiUsage';
import { sameSize } from './pi-scan-match';
import { codeBedSize } from './pi-scan-sku';
import { CLAUDE_MODEL, anthropicFetchWithRetry, stripJsonFences, type AnthropicResponse } from './scan-ocr';
import { lineSizeOf, printedSize } from './scan-word-match';

export type AiRow = { n: number; code: string | null; description: string | null; size: string | null; unitPrice: number | null };
export type AiSku = { itemCode: string; description: string | null; supplierSku: string | null; grns: string };
/** Row number -> our item code. */
export type AiSkuMatcher = (rows: ReadonlyArray<AiRow>, skus: ReadonlyArray<AiSku>) => Promise<Map<number, string>>;

export const AI_MATCH_FEATURE = 'scan_pi_match';
const MAX_SKUS = 400;
const HIGH = 0.85;

/** The size a printed row names, as our codes spell it: (Q) in its code, else 5FT / 152X190 in its name. */
export const rowSize = (code: string | null, description: string | null): string | null =>
  codeBedSize(code) ?? printedSize(description) ?? printedSize(code);

export function buildAiMatchPrompt(rows: ReadonlyArray<AiRow>, skus: ReadonlyArray<AiSku>): string {
  const rowText = rows.map((r) => `${r.n}. code: ${r.code ?? '-'} | description: ${r.description ?? '-'} | size: ${r.size ?? '-'} | unit price: ${r.unitPrice ?? '-'}`).join('\n');
  const skuText = skus.slice(0, MAX_SKUS).map((s) => `${s.itemCode} | ${s.description ?? '-'} | supplier code: ${s.supplierSku ?? '-'} | open on: ${s.grns}`).join('\n');
  return [
    'A supplier invoice prints its own product codes. Match each invoice row to the one SKU of ours it is, from the list of SKUs this supplier still has to bill.',
    'Our SKU codes are usually the model name plus a size tag: (S) single, (SS) super single, (Q) queen 5ft 152cm, (K) king 6ft 183cm, (SK) super king.',
    'The supplier code may be a number; match on the model name in the description, the size and the price. A row is never a SKU of another size.',
    'If no SKU is clearly the row, answer null for it. Do not guess.',
    '',
    'INVOICE ROWS:',
    rowText,
    '',
    'OUR OPEN SKUS (code | our description | supplier code | receipts):',
    skuText,
    '',
    'Respond with VALID JSON ONLY: {"matches":[{"row":1,"sku":"<our code exactly as listed, or null>","confidence":"high"|"medium"|"low"}]}',
  ].join('\n');
}

const confidenceOf = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? v / 100 : v;
  if (typeof v === 'string') return ({ high: 1, medium: 0.6, low: 0.3 } as Record<string, number>)[v.trim().toLowerCase()] ?? 0;
  return 0;
};

/** The model's answer, kept only where it is sure, names a SKU we listed, and
 *  that SKU is the size the row prints. Anything else is dropped. */
export function parseAiMatches(text: string | null, rows: ReadonlyArray<AiRow>, skus: ReadonlyArray<AiSku>): Map<number, string> {
  const out = new Map<number, string>();
  if (!text) return out;
  let json: unknown;
  try { json = JSON.parse(stripJsonFences(text)); } catch { return out; }
  const matches = (json as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(matches)) return out;
  const known = new Map(skus.map((s) => [s.itemCode.trim().toUpperCase(), s.itemCode]));
  const rowByN = new Map(rows.map((r) => [r.n, r]));
  for (const m of matches) {
    const x = (m ?? {}) as Record<string, unknown>;
    const row = rowByN.get(Number(x.row));
    const sku = typeof x.sku === 'string' ? known.get(x.sku.trim().toUpperCase()) : undefined;
    if (!row || !sku || out.has(row.n) || confidenceOf(x.confidence) < HIGH) continue;
    if (!sameSize(row.code, sku)) continue;
    const size = rowSize(row.code, row.description);
    const ours = lineSizeOf(sku);
    if (size && ours && size !== ours) continue;
    out.set(row.n, sku);
  }
  return out;
}

/** The matcher for one scan, or null when the server has no key (rows stay as they are). */
export function aiSkuMatcher(env: Env, companyId: number | null, userId: number | null): AiSkuMatcher | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const tag: AiUsageTag = { env, feature: AI_MATCH_FEATURE, model: CLAUDE_MODEL, companyId, userId, waitUntil: null };
  return async (rows, skus) => {
    if (rows.length === 0 || skus.length === 0) return new Map();
    try {
      const resp = await recordAi(tag, anthropicFetchWithRetry({
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: CLAUDE_MODEL, max_tokens: 2048, temperature: 0,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildAiMatchPrompt(rows, skus) }] }],
        }),
      }));
      if (!resp.ok) { console.warn('[pi-scan-ai] match refused:', resp.status); return new Map(); }
      const body = await resp.json() as AnthropicResponse;
      return parseAiMatches(body.content?.find((b) => b.type === 'text')?.text ?? null, rows, skus);
    } catch (e) {
      console.warn('[pi-scan-ai] match failed, rows left as they are:', (e as Error).message);
      return new Map();
    }
  };
}
