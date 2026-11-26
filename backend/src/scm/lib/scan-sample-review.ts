// ---------------------------------------------------------------------------
// Scan sample review — closes the OCR self-learning loop on the BACKGROUND
// scan path.
//
// The interactive path (operator reviews the extraction inside the New SO
// form, desktop or mobile) POSTs /scan-so/samples/:id/confirm on save. That
// path has NO live caller any more — both call sites are gated on a scan
// handoff nothing performs since the modal became a pure /enqueue surface
// (docs/modules/scan-to-so.md §4). The BACKGROUND path (POST /scan-so/enqueue
// -> queue -> DRAFT SO) is the only one that runs: runScanJob stamps
// scan_jobs.sample_id (scan-so.ts) and then nothing ever confirms that sample.
// The operator's review DOES happen — they open the DRAFT and either confirm
// it or edit it — but that event was wired to nothing, so the main scan route
// fed the loop NOTHING. This module is what listens to it.
//
// The confirmation event is the DRAFT -> CONFIRMED status transition
// (PATCH /mfg-sales-orders/:docNo/status).
//
// TWO outcomes are captured here, and they teach different consumers:
//
//   confirmed UNCHANGED -> ACCEPTED, `corrected = extracted`. The DRAFT is
//     built FROM the sample's `extracted` blob, so "the operator changed
//     nothing" makes `corrected = extracted` exactly true — the same object,
//     no shape to get wrong. Feeds the few-shot pool only (zero diff).
//
//   confirmed WITH EDITS -> CONFIRMED, `corrected` REBUILT from the final SO.
//     This is the diff-bearing pair every distiller mines, and until this
//     landed it was thrown away: the corrections — the single most valuable
//     signal in the module — were discarded. The blob is NOT a reversal of the
//     whole lossy slip -> SO mapper. It is `extracted` with a CURATED set of
//     faithfully-invertible fields overlaid from the operator's final SO; every
//     field whose forward mapping is lossy, derived or repriced is carried
//     across from `extracted` untouched, so it contributes NO diff and cannot
//     teach a rule the operator never wrote. See buildCorrectedSlipFromSo for
//     the field-by-field reasoning, and CARRIED_NOT_INVERTED for the exclusions.
//
// The old rule ("an edited draft is left alone, because writing
// corrected = extracted for it would assert the AI read correctly about a
// reading a human had just fixed") is NOT relaxed — it is honoured. We never
// write `corrected = extracted` for an edited draft. We either write the
// operator's real values, or, when the edit touched nothing the OCR emits,
// we still write nothing at all.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { recordSlipAliases, slipAliasPairs } from './scan-field-aliases';
import { HEADER_FIELDS, LINE_FIELDS, asObj, changedFields, isDroppedBlankLine } from './scan-slip-fields';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

const SAMPLE_EXTRACTED = 'EXTRACTED';
const SAMPLE_ACCEPTED = 'ACCEPTED';
const SAMPLE_CORRECTED = 'CONFIRMED';

const NON_EDIT_ACTIONS = '("CREATE","UPDATE_STATUS")';

const SHELL_NAME = 'Scan — please complete';
const SHELL_PHONE = 'To be confirmed';

const OPERATOR_REASON = 'operator-confirmed';

export const CARRIED_NOT_INVERTED = Object.freeze([
  'remarks', 'location', 'locationMatch', 'slipDate', 'priceRmGuess',
  'installmentPlanMatch', 'onlineTypeMatch', 'totalRm', 'salesRep',
  'paymentMethod', 'images', 'payments',
]);


export type SoHeaderSnapshot = Record<string, unknown>;
export type SoItemSnapshot = Record<string, unknown>;

const SO_HEADER_COLS =
  'debtor_name, phone, emergency_contact_phone, address1, city, postcode, customer_state, ' +
  'customer_so_no, customer_type, building_type, payment_method, merchant_provider, ' +
  'approval_code, deposit_sen, customer_delivery_date, company_id';
const SO_ITEM_COLS = 'item_group, item_code, qty, unit_price_sen, variants, cancelled, line_no, created_at';

function col(row: Record<string, unknown> | null | undefined, snake: string): unknown {
  if (!row) return null;
  if (row[snake] !== undefined) return row[snake];
  const camel = snake.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
  return row[camel] === undefined ? null : row[camel];
}

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

type OptionMatch = { value: string; confidence: number; reason: string };
type CodeMatch = { code: string; confidence: number; reason: string };
const optMatch = (v: unknown): OptionMatch | null => {
  const t = text(v);
  return t === null ? null : { value: t, confidence: 1, reason: OPERATOR_REASON };
};
const codeMatch = (v: unknown): CodeMatch | null => {
  const t = text(v);
  return t === null ? null : { code: t, confidence: 1, reason: OPERATOR_REASON };
};

function unprefixPhone(v: unknown): string | null {
  const t = text(v);
  if (t === null || t === SHELL_PHONE) return null;
  const compact = t.replace(/\s+/g, '');
  return compact.startsWith('+60') ? compact.slice(3) : compact;
}

function isSlipLine(it: SoItemSnapshot): boolean {
  if (String(col(it, 'item_group') ?? '').toLowerCase() === 'service') return false;
  if (col(it, 'cancelled') === true) return false;
  const v = col(it, 'variants');
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if (rec.freeGift != null || rec.freeItem != null) return false;
  }
  return true;
}

function variantsOf(it: SoItemSnapshot): Record<string, unknown> {
  const v = col(it, 'variants');
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const upperCode = (v: unknown): string => (text(v) ?? '').toUpperCase();


/**
 * Pair the SO's slip-derived lines back to the extraction's lines.
 *
 * buildDraftSoBodyFromSlip walks `parsed.lines` IN ORDER and emits at most one
 * item per slip line, so the draft's lines start life as an order-preserving
 * image of the extraction. Operator edits keep that order (a line PATCH keeps
 * the row, a delete removes it in place, an add appends), so the two sequences
 * stay monotonically comparable — but a changed itemCode means the position,
 * not the value, is the only thing linking them.
 *
 * So: anchor greedily and monotonically on UNCHANGED item codes, then fill each
 * gap between anchors positionally, and ONLY when the two sides of that gap are
 * the same length. An unequal gap is genuinely ambiguous (which slip row was
 * deleted, which item was added?), and mis-pairing rawText with a code would
 * teach the alias distiller a handwriting -> SKU mapping nobody wrote. There we
 * pair the item with NOTHING: the line still carries the operator's code and
 * qty, but no slip provenance is asserted. Losing signal is acceptable; a wrong
 * pair is not.
 */
export function alignSoLinesToSlip(
  slipLines: Array<Record<string, unknown>>,
  items: SoItemSnapshot[],
): Array<{ item: SoItemSnapshot; slip: Record<string, unknown> | null }> {
  const anchors: Array<[number, number]> = [];
  let cursor = 0;
  for (let ii = 0; ii < items.length; ii++) {
    const code = upperCode(col(items[ii], 'item_code'));
    if (!code) continue;
    for (let sj = cursor; sj < slipLines.length; sj++) {
      const sm = slipLines[sj]?.skuMatch as { code?: unknown } | null | undefined;
      if (upperCode(sm?.code) === code) {
        anchors.push([ii, sj]);
        cursor = sj + 1;
        break;
      }
    }
  }

  const out: Array<{ item: SoItemSnapshot; slip: Record<string, unknown> | null }> = [];
  let prevItem = -1;
  let prevSlip = -1;
  const fillGap = (itemEnd: number, slipEnd: number): void => {
    const gapItems = itemEnd - prevItem - 1;
    const gapSlip = slipEnd - prevSlip - 1;
    const sameShape = gapItems === gapSlip;
    for (let k = 0; k < gapItems; k++) {
      const item = items[prevItem + 1 + k];
      if (item === undefined) continue;
      out.push({ item, slip: sameShape ? (slipLines[prevSlip + 1 + k] ?? null) : null });
    }
  };
  for (const [ii, sj] of anchors) {
    fillGap(ii, sj);
    const anchored = items[ii];
    if (anchored !== undefined) out.push({ item: anchored, slip: slipLines[sj] ?? null });
    prevItem = ii;
    prevSlip = sj;
  }
  fillGap(items.length, slipLines.length);
  return out;
}

function blankSlipLine(): Record<string, unknown> {
  return {
    rawText: '',
    rawSpec: null,
    divanHeightInches: null,
    legHeightInches: null,
    gapInches: null,
    noLeg: false,
    seatHeightInches: null,
    qtyGuess: 1,
    priceRmGuess: null,
    skuMatch: null,
    fabricMatch: null,
    specialsMatch: [],
    notes: null,
  };
}


/**
 * Rebuild the operator's FINAL values in ExtractedSlip shape, starting from the
 * AI's own `extracted` blob so that everything the operator did not touch stays
 * byte-identical and contributes no diff.
 *
 * THE ONE RULE THIS FUNCTION OBEYS: a key is overwritten only when its value
 * genuinely MOVED. Blind overwriting is what makes a reconstruction dangerous —
 * re-stamping an unchanged `skuMatch` with `reason: 'operator-confirmed'` would
 * make every line of every sample "differ", and the distillers turn every
 * difference into a rule. So each overlay compares the SO's value against the
 * AI's on the axis that carries meaning (the text, the match VALUE, the code
 * set) and leaves the AI's object in place when they agree.
 *
 * Pure — no I/O, no clock, no randomness. Returns null when `extracted` is not
 * an object (a FAILED / malformed sample has nothing to overlay onto) or when
 * the SO header could not be read.
 */
export function buildCorrectedSlipFromSo(
  extracted: unknown,
  header: SoHeaderSnapshot | null,
  items: SoItemSnapshot[],
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) return null;
  const ai = extracted as Record<string, unknown>;
  if (!header) return null;

  const out: Record<string, unknown> = { ...ai };

  const sameText = (a: unknown, b: unknown): boolean => (text(a) ?? '') === (text(b) ?? '');
  const putText = (key: string, v: unknown): void => {
    if (!sameText(ai[key], v)) out[key] = text(v);
  };
  const putOpt = (key: string, v: unknown): void => {
    const cur = (ai[key] as { value?: unknown } | null | undefined)?.value;
    if (!sameText(cur, v)) out[key] = optMatch(v);
  };

  const debtor = text(col(header, 'debtor_name'));
  if (debtor !== null) putText('customerName', debtor === SHELL_NAME ? null : debtor);

  const addressKey = text(ai.addressLine1) !== null || text(ai.address) === null
    ? 'addressLine1'
    : 'address';
  putText(addressKey, col(header, 'address1'));
  putText('city', col(header, 'city'));
  putText('postcode', col(header, 'postcode'));
  putOpt('addressStateMatch', col(header, 'customer_state'));

  const invPhones = [unprefixPhone(col(header, 'phone')), unprefixPhone(col(header, 'emergency_contact_phone'))]
    .filter((p): p is string => p !== null);
  const aiPhones = (Array.isArray(ai.phones) ? (ai.phones as unknown[]) : []).map((p) => text(p) ?? '');
  const aiHead = aiPhones.slice(0, 2);
  if (aiHead.length !== invPhones.length || aiHead.some((p, i) => p !== invPhones[i])) {
    out.phones = invPhones;
  }

  putText('customerSoRef', col(header, 'customer_so_no'));
  putOpt('customerTypeMatch', col(header, 'customer_type'));
  putOpt('buildingTypeMatch', col(header, 'building_type'));

  const method = text(col(header, 'payment_method'));
  putOpt('paymentMethodMatch', method);
  if (method === 'Merchant') putOpt('bankMatch', col(header, 'merchant_provider'));
  putText('approvalCode', col(header, 'approval_code'));

  const depositSen = numOrNull(col(header, 'deposit_sen'));
  const invDeposit = depositSen !== null && depositSen > 0 ? depositSen / 100 : null;
  if ((numOrNull(ai.depositRm) ?? 0) !== (invDeposit ?? 0)) out.depositRm = invDeposit;

  const deliv = text(col(header, 'customer_delivery_date'));
  if (deliv !== null) putText('deliveryDate', deliv);

  const slipLines = Array.isArray(ai.lines) ? (ai.lines as Array<Record<string, unknown>>) : [];
  const slipItems = items.filter(isSlipLine);
  out.lines = alignSoLinesToSlip(slipLines, slipItems).map(({ item, slip }) => {
    const base = slip ?? blankSlipLine();
    const v = variantsOf(item);
    const line: Record<string, unknown> = { ...base };

    const qty = numOrNull(col(item, 'qty')) ?? 1;
    if (numOrNull(base.qtyGuess) !== qty) line.qtyGuess = qty;

    const code = text(col(item, 'item_code'));
    const baseCode = (base.skuMatch as { code?: unknown } | null | undefined)?.code;
    if (upperCode(baseCode) !== upperCode(code)) line.skuMatch = codeMatch(code);

    const fabric = text(v.fabricCode);
    if (fabric !== null) {
      const baseFabric = (base.fabricMatch as { code?: unknown } | null | undefined)?.code;
      if (upperCode(baseFabric) !== upperCode(fabric)) line.fabricMatch = codeMatch(fabric);
    }
    if (Array.isArray(v.specials)) {
      const invSpecials = (v.specials as unknown[])
        .map((s) => text(s))
        .filter((s): s is string => s !== null);
      const baseSpecials = (Array.isArray(base.specialsMatch) ? (base.specialsMatch as unknown[]) : [])
        .map((s) => upperCode((s as { code?: unknown } | null | undefined)?.code));
      const invUpper = invSpecials.map((s) => s.toUpperCase());
      if (baseSpecials.length !== invUpper.length || baseSpecials.some((s, i) => s !== invUpper[i])) {
        line.specialsMatch = invSpecials.map((s) => codeMatch(s)).filter((s): s is CodeMatch => s !== null);
      }
    }
    return line;
  });

  return out;
}


async function readSoDraft(
  svc: SupabaseClient,
  docNo: string,
): Promise<{ header: SoHeaderSnapshot | null; items: SoItemSnapshot[]; error: string | null }> {
  const [{ data: headerRow, error: headerErr }, { data: itemRows, error: itemsErr }] = await Promise.all([
    svc.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle(),
    svc
      .from('mfg_sales_order_items')
      .select(SO_ITEM_COLS)
      .eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);
  const failure = (headerErr ?? itemsErr) as { message?: string } | null;
  return {
    header: (headerRow as SoHeaderSnapshot | null) ?? null,
    items: (itemRows as SoItemSnapshot[] | null) ?? [],
    error: failure ? (failure.message ?? 'read failed') : null,
  };
}

export interface SnapshotDraftBaselineArgs {
  sampleId: string;
  docNo: string;
  extracted: unknown;
}

/**
 * Store the draft's own shape (after every automatic write) on the sample.
 * Never throws: a failed snapshot must not fail the scan job. The sample then
 * has no baseline and is reviewed the old way.
 */
export async function snapshotDraftBaseline(
  svc: SupabaseClient,
  { sampleId, docNo, extracted }: SnapshotDraftBaselineArgs,
): Promise<void> {
  try {
    const draft = await readSoDraft(svc, docNo);
    if (draft.error !== null || draft.header === null) {
      throw new Error(draft.error ?? 'draft header not found');
    }
    const rawBlob = asObj(extracted);
    const baseline = rawBlob === null ? null : buildCorrectedSlipFromSo(withoutDroppedBlankLines(rawBlob), draft.header, draft.items);
    if (baseline === null) throw new Error('baseline could not be built from the extraction');
    const { error: writeErr } = await svc.from('so_scan_samples').update({ draft_baseline: baseline }).eq('id', sampleId);
    if (writeErr) throw new Error(writeErr.message);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[scan-sample-review] draft baseline snapshot failed (non-fatal):', { sampleId, docNo }, (e as Error).message);
  }
}

export const LEARNING_POOL_CLEAN_SINCE = '2026-11-16T16:00:00.000Z';
export const LEARNING_POOL_BASELINE_FILTER = `draft_baseline.not.is.null,created_at.gte.${LEARNING_POOL_CLEAN_SINCE}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asLines = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];

function canonical(v: unknown): string {
  const sorted = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sorted);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, sorted(val)]),
      );
    }
    return x ?? null;
  };
  return JSON.stringify(sorted(v));
}

const isDroppedRawLine = (l: Record<string, unknown>): boolean =>
  isDroppedBlankLine(l.rawText, asObj(l.skuMatch)?.code != null);

function withoutDroppedBlankLines(extracted: Record<string, unknown>): Record<string, unknown> {
  return { ...extracted, lines: asLines(extracted.lines).filter((l) => !isDroppedRawLine(l)) };
}

export function uniqueByRawText(
  lines: Array<Record<string, unknown>>,
  rawText: unknown,
): Record<string, unknown> | null {
  if (typeof rawText !== 'string' || rawText.trim() === '') return null;
  const hits = lines.filter((l) => l.rawText === rawText);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * `extracted` with only the fields a person changed on the draft: a field of
 * `final` is taken only when it differs from `baseline` (the draft as the
 * pipeline left it). Pure; none of the inputs is mutated. Compares are
 * key-order independent.
 *
 * Line changes are judged baseline vs final only: if no line moved, the raw
 * lines are returned verbatim (the pipeline drops blank raw lines, so counts
 * against the raw read differ on an untouched draft). Otherwise a final line is
 * tied to its baseline and raw line only through a unique non-empty rawText;
 * a line that cannot be tied that way has no slip provenance and is taken from
 * `final` as it is. Lines are never paired by position.
 */
export function keepPersonChanges(
  extracted: Record<string, unknown>,
  baseline: Record<string, unknown>,
  final: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extracted };
  const rawDate = extracted.deliveryDate;
  for (const [key] of HEADER_FIELDS) {
    if (canonical(final[key]) === canonical(baseline[key])) continue;
    if (key === 'deliveryDate' && !(typeof rawDate === 'string' && ISO_DATE.test(rawDate))) continue;
    out[key] = final[key];
  }

  const extractedLines = asLines(extracted.lines);
  const baselineLines = asLines(baseline.lines);
  const finalLines = asLines(final.lines);
  if (canonical(baselineLines) === canonical(finalLines)) return out;

  const isBlankRawLine = isDroppedRawLine;
  const keptLines = finalLines.map((finalLine) => {
    const baseLine = uniqueByRawText(baselineLines, finalLine.rawText);
    const rawLine = baseLine === null ? null : uniqueByRawText(extractedLines, baseLine.rawText);
    if (baseLine === null || rawLine === null || uniqueByRawText(finalLines, finalLine.rawText) === null) return finalLine;
    const kept: Record<string, unknown> = { ...rawLine };
    for (const [key] of LINE_FIELDS) if (canonical(finalLine[key]) !== canonical(baseLine[key])) kept[key] = finalLine[key];
    return kept;
  });
  out.lines = [...keptLines, ...extractedLines.filter(isBlankRawLine)];
  return out;
}


/**
 * Called on a DRAFT -> CONFIRMED transition. If this SO came from a background
 * scan, record the operator's verdict on the extraction that produced it:
 * confirmed as-is lands ACCEPTED (few-shot pool), confirmed with edits lands
 * CONFIRMED carrying the operator's corrections (the pool every distiller
 * mines).
 *
 * Best-effort and silent: never throws, never blocks the status change. A scan
 * sample failing to record must not cost the operator their confirm.
 */
export async function noteScanDraftAccepted(
  svc: SupabaseClient,
  docNo: string,
): Promise<void> {
  try {
    const { data: jobRow } = await svc
      .from('scan_jobs')
      .select('sample_id')
      .eq('so_doc_no', docNo)
      .not('sample_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!jobRow) return;
    const jobIds = jobRow as { sampleId?: string | null; sample_id?: string | null };
    const sampleId = jobIds.sampleId ?? jobIds.sample_id ?? null;
    if (!sampleId) return;

    const { data: sample } = await svc
      .from('so_scan_samples')
      .select('extracted, status, draft_baseline')
      .eq('id', sampleId)
      .maybeSingle();
    const s = sample as { extracted?: unknown; status?: string | null; draft_baseline?: unknown } | null;
    if (!s || s.status !== SAMPLE_EXTRACTED || s.extracted == null) return;

    const baseline = asObj(s.draft_baseline);
    const extractedBlob = asObj(s.extracted);
    if (baseline && extractedBlob) {
      const draft = await readSoDraft(svc, docNo);
      if (draft.error !== null || draft.header === null) {
        console.warn('[scan-sample-review] draft unreadable, sample left as is:', { sampleId, docNo }, draft.error ?? 'no header');
        return;
      }
      const final = buildCorrectedSlipFromSo(withoutDroppedBlankLines(extractedBlob), draft.header, draft.items);
      if (final === null) return;
      const kept = keepPersonChanges(extractedBlob, baseline, final);
      if (changedFields(extractedBlob, kept).length === 0) {
        await svc
          .from('so_scan_samples')
          .update({ corrected: s.extracted, status: SAMPLE_ACCEPTED })
          .eq('id', sampleId)
          .eq('status', SAMPLE_EXTRACTED);
        return;
      }
      await svc
        .from('so_scan_samples')
        .update({ corrected: kept, status: SAMPLE_CORRECTED })
        .eq('id', sampleId)
        .eq('status', SAMPLE_EXTRACTED);
      const keptCompanyId = Number(col(draft.header, 'company_id'));
      if (Number.isInteger(keptCompanyId) && keptCompanyId > 0) {
        await recordSlipAliases(svc, keptCompanyId, slipAliasPairs(extractedBlob, kept));
      }
      return;
    }

    const { data: edits } = await svc
      .from('mfg_so_audit_log')
      .select('id')
      .eq('so_doc_no', docNo)
      .not('action', 'in', NON_EDIT_ACTIONS)
      .or('source.is.null,source.neq.automation')
      .limit(1);
    const wasEdited = Array.isArray(edits) && edits.length > 0;

    if (!wasEdited) {
      await svc
        .from('so_scan_samples')
        .update({ corrected: s.extracted, status: SAMPLE_ACCEPTED })
        .eq('id', sampleId)
        .eq('status', SAMPLE_EXTRACTED);
      return;
    }

    const [{ data: headerRow }, { data: itemRows }] = await Promise.all([
      svc.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle(),
      svc
        .from('mfg_sales_order_items')
        .select(SO_ITEM_COLS)
        .eq('doc_no', docNo)
        .order('line_no', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true }),
    ]);
    const corrected = buildCorrectedSlipFromSo(
      s.extracted,
      (headerRow as SoHeaderSnapshot | null) ?? null,
      ((itemRows as SoItemSnapshot[] | null) ?? []),
    );
    if (corrected === null) return;

    if (JSON.stringify(corrected) === JSON.stringify(s.extracted)) return;

    await svc
      .from('so_scan_samples')
      .update({ corrected, status: SAMPLE_CORRECTED })
      .eq('id', sampleId)
      .eq('status', SAMPLE_EXTRACTED);

    /* HC-0006 T8: the same corrections, as exact aliases the next scan of this
       company applies (scan-field-aliases.ts). */
    const companyId = Number(col(headerRow as SoHeaderSnapshot | null, 'company_id'));
    if (Number.isInteger(companyId) && companyId > 0) {
      await recordSlipAliases(svc, companyId, slipAliasPairs(s.extracted as Record<string, unknown>, corrected));
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[scan-sample-review] review note failed (non-fatal):', docNo, (e as Error).message);
  }
}

export async function notePiScanAccepted(
  svc: SupabaseClient,
  args: { piId: string; invoiceNumber: string },
): Promise<void> {
  try {
    const { piId, invoiceNumber } = args;
    const { data: jobRow, error: jobErr } = await svc
      .from('scan_jobs')
      .select('sample_id')
      .eq('linked_doc_no', invoiceNumber)
      .eq('document_type', 'PI')
      .not('sample_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobErr || !jobRow) return;
    const jobIds = jobRow as { sampleId?: string | null; sample_id?: string | null };
    const sampleId = jobIds.sampleId ?? jobIds.sample_id ?? null;
    if (!sampleId) return;

    const { data: edits, error: editsErr } = await svc
      .from('entity_audit_log')
      .select('id')
      .eq('entity_type', 'PURCHASE_INVOICE')
      .eq('entity_id', piId)
      .not('action', 'in', '("CREATE","POST")')
      .limit(1);
    if (editsErr) return;
    const wasEdited = Array.isArray(edits) && edits.length > 0;

    const { data: sample, error: sampleErr } = await svc
      .from('so_scan_samples')
      .select('extracted, status, document_type')
      .eq('id', sampleId)
      .maybeSingle();
    if (sampleErr) return;
    const s = sample as { extracted?: unknown; status?: string | null; document_type?: string | null } | null;
    if (!s || s.status !== SAMPLE_EXTRACTED || s.document_type !== 'PI' || s.extracted == null) return;

    if (!wasEdited) {
      await svc
        .from('so_scan_samples')
        .update({ corrected: s.extracted, status: SAMPLE_ACCEPTED })
        .eq('id', sampleId)
        .eq('status', SAMPLE_EXTRACTED);
      return;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[scan-sample-review] PI review note failed (non-fatal):', args.invoiceNumber, (e as Error).message);
  }
}
