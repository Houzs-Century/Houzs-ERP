// ---------------------------------------------------------------------------
// Scan field aliases (HC-0006 T8): what the model misread -> what the operator
// corrected it to, per company, for the sales slip. Read BEFORE the model call
// (passed in as a hint) and applied exactly to the model's output, so a field
// corrected once comes back corrected on the next scan of the same handwriting.
//
// Fed by noteScanDraftAccepted (DRAFT -> CONFIRMED with edits): the pairs come
// from the same `corrected` blob the distillers mine. Starts with three fields:
// customer name, the first phone, and a line's item code keyed on the line's
// slip text.
// ---------------------------------------------------------------------------
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the service client is schema-parameterised; same alias as scan-sample-review.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export type SlipAliasField = 'customerName' | 'phone' | 'itemCode';
export type FieldAlias = { field: SlipAliasField; raw: string; value: string };

const KIND = 'so';
/* ponytail: newest 500 per company; a bigger table needs a lookup by raw. */
const LOAD_LIMIT = 500;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
/** The match key: case and runs of space never matter. */
export const aliasKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toUpperCase();
/** A phone compared as its national digits, so a format change is not a correction. */
const phoneKey = (s: string): string => s.replace(/\D/g, '').replace(/^60/, '').replace(/^0/, '');

type Slip = Record<string, unknown>;
type Line = Record<string, unknown>;
const linesOf = (s: Slip): Line[] => (Array.isArray(s.lines) ? (s.lines as Line[]) : []);
const codeOf = (l: Line): string | null => str((l.skuMatch as { code?: unknown } | null | undefined)?.code);

/** The corrections in one confirmed pair. Pure. A field the operator blanked teaches nothing. */
export function slipAliasPairs(extracted: Slip, corrected: Slip): FieldAlias[] {
  const out: FieldAlias[] = [];
  const aiName = str(extracted.customerName);
  const opName = str(corrected.customerName);
  if (aiName && opName && aliasKey(aiName) !== aliasKey(opName)) out.push({ field: 'customerName', raw: aiName, value: opName });

  const aiPhone = str((extracted.phones as unknown[] | undefined)?.[0]);
  const opPhone = str((corrected.phones as unknown[] | undefined)?.[0]);
  if (aiPhone && opPhone && phoneKey(aiPhone) !== phoneKey(opPhone)) out.push({ field: 'phone', raw: aiPhone, value: opPhone });

  /* corrected.lines are in SO order and each spreads its slip line, so the slip
     text pairs them with the model's lines. */
  const aiByText = new Map(linesOf(extracted).flatMap((l) => {
    const t = str(l.rawText);
    return t ? [[aliasKey(t), l] as const] : [];
  }));
  for (const l of linesOf(corrected)) {
    const t = str(l.rawText);
    const ai = t ? aiByText.get(aliasKey(t)) : undefined;
    const aiCode = ai ? codeOf(ai) : null;
    const opCode = codeOf(l);
    if (t && opCode && aliasKey(aiCode ?? '') !== aliasKey(opCode)) out.push({ field: 'itemCode', raw: t, value: opCode });
  }
  return out;
}

export async function recordSlipAliases(svc: SupabaseClient, companyId: number, pairs: FieldAlias[]): Promise<void> {
  if (pairs.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await svc.from('scan_field_aliases').upsert(
    pairs.map((p) => ({ company_id: companyId, kind: KIND, field: p.field, raw_key: aliasKey(p.raw), raw: p.raw, value: p.value, updated_at: now })),
    { onConflict: 'company_id,kind,field,raw_key' },
  );
  if (error) console.warn('[scan-field-aliases] record failed (non-fatal):', error.message);
}

export async function loadSlipAliases(svc: SupabaseClient, companyId: number): Promise<FieldAlias[]> {
  const { data, error } = await svc
    .from('scan_field_aliases')
    .select('field, raw, value')
    .eq('company_id', companyId)
    .eq('kind', KIND)
    .order('updated_at', { ascending: false })
    .limit(LOAD_LIMIT);
  if (error) {
    console.warn('[scan-field-aliases] load failed (non-fatal):', error.message);
    return [];
  }
  return (data as FieldAlias[] | null) ?? [];
}

/** The hint the model sees before it reads. Empty when nothing is learnt. */
export function aliasHint(aliases: FieldAlias[]): string {
  if (aliases.length === 0) return '';
  const label: Record<SlipAliasField, string> = { customerName: 'customer name', phone: 'phone', itemCode: 'line text -> item code' };
  return 'CONFIRMED CORRECTIONS for this company. When the slip reads as the left side, the operator ' +
    'confirmed the right side:\n' + aliases.map((a) => `- ${label[a.field]}: "${a.raw}" -> "${a.value}"`).join('\n');
}

/** Overwrite exact hits on the model's output, in place. Returns the fields changed. */
export function applySlipAliases(parsed: Slip, aliases: FieldAlias[]): SlipAliasField[] {
  const by = (f: SlipAliasField) => new Map(aliases.filter((a) => a.field === f).map((a) => [f === 'phone' ? phoneKey(a.raw) : aliasKey(a.raw), a.value]));
  const changed: SlipAliasField[] = [];
  const name = str(parsed.customerName);
  const nameHit = name ? by('customerName').get(aliasKey(name)) : undefined;
  if (nameHit) { parsed.customerName = nameHit; changed.push('customerName'); }

  const phones = Array.isArray(parsed.phones) ? (parsed.phones as unknown[]) : [];
  const p0 = str(phones[0]);
  const phoneHit = p0 ? by('phone').get(phoneKey(p0)) : undefined;
  if (phoneHit) { phones[0] = phoneHit; changed.push('phone'); }

  const codes = by('itemCode');
  for (const l of linesOf(parsed)) {
    const t = str(l.rawText);
    const hit = t ? codes.get(aliasKey(t)) : undefined;
    if (hit && aliasKey(codeOf(l) ?? '') !== aliasKey(hit)) {
      l.skuMatch = { code: hit, confidence: 1, reason: 'operator alias' };
      if (!changed.includes('itemCode')) changed.push('itemCode');
    }
  }
  return changed;
}

/** One sales-slip read: load the company's aliases, call the model with them as a
 *  hint, then apply exact hits. Alias failures never fail the scan. */
export async function readSlipWithAliases<T extends { parsed: Slip | null }>(
  svc: SupabaseClient,
  companyId: number | null,
  callModel: (hint: string) => Promise<T>,
): Promise<T> {
  const aliases = companyId === null ? [] : await loadSlipAliases(svc, companyId).catch(() => []);
  const call = await callModel(aliasHint(aliases));
  if (call.parsed) applySlipAliases(call.parsed, aliases);
  return call;
}
