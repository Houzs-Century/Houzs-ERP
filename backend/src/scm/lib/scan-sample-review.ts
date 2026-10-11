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

// getSupabaseService is schema-parameterised (db:{schema:'scm'}), so the bare
// SupabaseClient type does not accept it. Same loosened alias scan-so.ts uses.
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

// Mirrors scan-so.ts's SAMPLE_* vocabulary (so_scan_samples.status is
// free-text — no check constraint, no migration). Note the trap documented
// there: the stored string is CONFIRMED; it MEANS "corrected".
const SAMPLE_EXTRACTED = 'EXTRACTED';
const SAMPLE_ACCEPTED = 'ACCEPTED';
const SAMPLE_CORRECTED = 'CONFIRMED';

/* The only audit actions that do NOT mean "a human changed the order's
   content": CREATE is the scan job's own row, UPDATE_STATUS is the very
   transition that calls us. Any OTHER action is an operator touching the
   substance of what the OCR produced. Listing the exclusions (rather than
   enumerating edit actions) is deliberate: a new mutation action added later
   counts as an edit by default, which fails toward "don't claim the AI was
   right". */
const NON_EDIT_ACTIONS = '("CREATE","UPDATE_STATUS")';

/* The placeholders buildDraftSoBodyFromSlip substitutes when the slip was
   missing a required field (scan-so.ts:3535-3536, "shell mode"). They are the
   pipeline's own words, never the operator's and never the slip's — inverting
   them would teach the model to read a blank slip as this literal text.
   Re-declared rather than imported: scan-so.ts imports createDraftSalesOrder
   from routes/mfg-sales-orders.ts, which imports THIS module, so importing
   scan-so.ts here would close a cycle. */
const SHELL_NAME = 'Scan — please complete';
const SHELL_PHONE = 'To be confirmed';

/* Every match this module writes is the operator's confirmed pick, so it
   carries full confidence and a reason that names its provenance — the same
   wording the (now dead) interactive confirm used, so old and new CONFIRMED
   rows read identically to the distillers. */
const OPERATOR_REASON = 'operator-confirmed';

/* Fields deliberately NOT inverted from the SO, and why. Each one's forward
   mapping is lossy, derived or overwritten downstream, so reading it back
   would manufacture a diff the operator never made — and the distillers turn
   every diff into a rule.

   remarks        the note is prefixed "POSSIBLE DUPLICATE of <doc_no>" by the
                  dedup path (scan-so.ts), so the SO note != the slip remark.
   location /     validateSlip may clear the venue, and the create core's
   locationMatch  venue-by-active-project autofill then RESOLVES it from the
                  rep's exhibition project — a venue the slip never named.
   slipDate       the slip's OWN written date. The SO has no column for it: the
                  forward mapper writes NEITHER date onto a scan draft (owner
                  2026-08-08, 2990-SO-2608-007 — a DRAFT never carries a
                  Processing Date, superseding the 2026-07-04 pin-to-today
                  rule). The SO's Processing Date (internal_expected_dd) is a
                  DIFFERENT fact the operator keys at review, so reading it back
                  into slipDate would teach the model to read the factory start
                  date off the slip's date line.
   priceRmGuess   the create core REPRICES every goods line through the
                  pricing engine, so unit_price_centi is the catalog's figure,
                  not the operator's correction of the handwritten one.
   installment-   the header stores an INTEGER month count; the pool's label
   PlanMatch      spelling ("One Shot" / "6 months") is not recoverable, and
                  inventing one breaks the module's never-invent rule.
   onlineTypeMatch there is no online_type column on the SO header at all (it
                  lives on the payment ledger row).
   totalRm,       no SO column is the slip's written grand total / the rep's
   salesRep,      signature / the raw payment words; the rep key is already
   paymentMethod  stamped on the sample.
   images,        extraction-time metadata, not an operator-reviewable value.
   payments
   rawText,       the line REMARK is deliberately kept CLEAN (owner, said many
   rawSpec,       times) — the raw slip transcription is never carried onto the
   notes, the     SO line, and the inch hints are collapsed into snapped
   inch hints     Maintenance-pool variant strings. Not recoverable; carried. */
export const CARRIED_NOT_INVERTED = Object.freeze([
  'remarks', 'location', 'locationMatch', 'slipDate', 'priceRmGuess',
  'installmentPlanMatch', 'onlineTypeMatch', 'totalRm', 'salesRep',
  'paymentMethod', 'images', 'payments',
]);

// ---------------------------------------------------------------------------
// Row shapes (only the columns this module reads)
// ---------------------------------------------------------------------------

export type SoHeaderSnapshot = Record<string, unknown>;
export type SoItemSnapshot = Record<string, unknown>;

const SO_HEADER_COLS =
  'debtor_name, phone, emergency_contact_phone, address1, city, postcode, customer_state, ' +
  'customer_so_no, customer_type, building_type, payment_method, merchant_provider, ' +
  'approval_code, deposit_centi, customer_delivery_date';
const SO_ITEM_COLS = 'item_group, item_code, qty, unit_price_centi, variants, cancelled, line_no, created_at';

/* postgres.js camelCases columns; PostgREST does not. Dual-read is the house
   rule (same shape as scan-so.ts's job serializer). */
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

/* The SO carries the phone as +60<national significant digits> (the create
   core normalises it); ExtractedSlip.phones holds the bare national digits
   (postProcessSlip). Strip the prefix back off so an untouched phone inverts
   to exactly the string the extraction produced and contributes no diff. */
function unprefixPhone(v: unknown): string | null {
  const t = text(v);
  if (t === null || t === SHELL_PHONE) return null;
  const compact = t.replace(/\s+/g, '');
  return compact.startsWith('+60') ? compact.slice(3) : compact;
}

/* Auto-generated lines are NOT slip lines and must never enter the pair: the
   create core appends SERVICE rows (delivery fee, addons) and the free-gift
   reconciler appends `variants.freeGift` rows, neither of which the OCR read
   or the operator wrote. A cancelled line is likewise not part of the order
   the operator confirmed. */
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

// ---------------------------------------------------------------------------
// Line alignment
// ---------------------------------------------------------------------------

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

/* An operator-added (or unpairable) line has no slip provenance. Emit it in the
   FULL ExtractedLine shape and key order normalizeSlip produces, so the pair
   the distiller reads is structurally uniform. */
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

// ---------------------------------------------------------------------------
// The corrected blob
// ---------------------------------------------------------------------------

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
  /** Overwrite a plain string field only when the trimmed text moved. */
  const putText = (key: string, v: unknown): void => {
    if (!sameText(ai[key], v)) out[key] = text(v);
  };
  /** Overwrite an OptionMatch only when its VALUE moved — an unchanged pick
   *  keeps the AI's own confidence/reason, so it reads as zero diff. */
  const putOpt = (key: string, v: unknown): void => {
    const cur = (ai[key] as { value?: unknown } | null | undefined)?.value;
    if (!sameText(cur, v)) out[key] = optMatch(v);
  };

  // ---- customer block -----------------------------------------------------
  const debtor = text(col(header, 'debtor_name'));
  // The shell placeholder is the pipeline's own words for "the slip did not
  // say" — invert it to null, never to the literal sentence.
  if (debtor !== null) putText('customerName', debtor === SHELL_NAME ? null : debtor);

  /* Address: write back into the SAME field the forward mapping read from
     (`addressLine1 ?? address`, scan-so.ts:3816). Writing both would rewrite
     the legacy full-address string with the street portion and invent a
     correction to `address` on every edited sample. */
  const addressKey = text(ai.addressLine1) !== null || text(ai.address) === null
    ? 'addressLine1'
    : 'address';
  putText(addressKey, col(header, 'address1'));
  putText('city', col(header, 'city'));
  putText('postcode', col(header, 'postcode'));
  putOpt('addressStateMatch', col(header, 'customer_state'));

  /* phones[0] -> phone, phones[1] -> emergency contact (scan-so.ts:3812,
     :3823). A slip that yielded a third number has nowhere to put it, so
     compare against the first two only and leave the array alone when those
     two still agree. */
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

  // ---- payment header -----------------------------------------------------
  const method = text(col(header, 'payment_method'));
  putOpt('paymentMethodMatch', method);
  /* merchant_provider is written ONLY when the method is Merchant
     (scan-so.ts:3841), so on any other method the column is null for a reason
     that has nothing to do with the operator. Mirror the forward gate exactly:
     invert on Merchant, carry the AI's read otherwise. */
  if (method === 'Merchant') putOpt('bankMatch', col(header, 'merchant_provider'));
  putText('approvalCode', col(header, 'approval_code'));

  /* depositRm -> deposit_centi collapses null and 0 onto the same column
     (scan-so.ts:3852), so compare on the collapsed value and only write when
     the money actually moved. */
  const depositCenti = numOrNull(col(header, 'deposit_centi'));
  const invDeposit = depositCenti !== null && depositCenti > 0 ? depositCenti / 100 : null;
  if ((numOrNull(ai.depositRm) ?? 0) !== (invDeposit ?? 0)) out.depositRm = invDeposit;

  /* Delivery date: only invert a date that is actually there. The forward rule
     drops a past / blank / unparseable slip date, and runScanJob retries the
     create DATELESS if the pair is rejected — so a null column means "the
     create refused it", not "the operator cleared it". Reading that back as a
     correction would teach the model it hallucinated a date it read correctly. */
  const deliv = text(col(header, 'customer_delivery_date'));
  if (deliv !== null) putText('deliveryDate', deliv);

  // ---- lines --------------------------------------------------------------
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

    /* fabricCode / specials are only written onto BEDFRAME and SOFA lines
       (scan-so.ts:3737-3741). Absent means "this category has no such axis" or
       "the operator cleared it" — indistinguishable — so absent CARRIES the
       AI's read rather than asserting an empty correction. A PRESENT value is
       the operator's, and is the exact signal the alias distiller mines. */
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

// ---------------------------------------------------------------------------

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
    // 1. Did this SO come from a background scan?
    //    NOTE: scan_jobs.so_doc_no is NOT indexed (0067 indexes created_at +
    //    salesperson; 0068 adds sample_id — the existing lookups all travel
    //    sample_id -> so_doc_no, this is the only one going the other way), so
    //    this is a scan of a table holding one row per scan. Fine at today's
    //    volume and it fires only on DRAFT -> CONFIRMED, but an index on
    //    so_doc_no is the right follow-up — that needs a migration, which is
    //    staging-first and out of scope here.
    const { data: jobRow } = await svc
      .from('scan_jobs')
      .select('sample_id')
      .eq('so_doc_no', docNo)
      .not('sample_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!jobRow) return;
    // postgres.js camelCases columns; PostgREST does not. Dual-read is the
    // house rule (same shape as scan-so.ts's job serializer).
    const j = jobRow as { sampleId?: string | null; sample_id?: string | null };
    const sampleId = j.sampleId ?? j.sample_id ?? null;
    if (!sampleId) return;

    // 2. Did a human change anything before confirming? The scan job's own
    //    writes are excluded by action (CREATE) and by source: the pipeline
    //    tags its payment rows source='automation' (scan-so.ts), operator
    //    writes default to 'web'.
    //    `source IS NULL` must count as an EDIT: a bare .neq('source',...)
    //    resolves to NULL for those rows and Postgres drops them from the
    //    result, which would read a genuine edit as "no edits" and label a
    //    corrected slip ACCEPTED. Unknown provenance fails toward not learning.
    const { data: edits } = await svc
      .from('mfg_so_audit_log')
      .select('id')
      .eq('so_doc_no', docNo)
      .not('action', 'in', NON_EDIT_ACTIONS)
      .or('source.is.null,source.neq.automation')
      .limit(1);
    const wasEdited = Array.isArray(edits) && edits.length > 0;

    // 3. Read the sample. Filtering on status='EXTRACTED' is the double-confirm
    //    guard: if the interactive path already confirmed this sample, or a
    //    previous transition already reviewed it, this matches 0 rows and does
    //    nothing. That keeps a scan counted exactly once no matter how many
    //    times the SO is re-confirmed (DRAFT -> CONFIRMED -> ON_HOLD -> ...).
    const { data: sample } = await svc
      .from('so_scan_samples')
      .select('extracted, status')
      .eq('id', sampleId)
      .maybeSingle();
    const s = sample as { extracted?: unknown; status?: string | null } | null;
    if (!s || s.status !== SAMPLE_EXTRACTED || s.extracted == null) return;

    // 4a. Unchanged — promote EXTRACTED -> ACCEPTED, carrying `extracted`
    //     across verbatim. Unchanged behaviour, deliberately untouched: this
    //     is the few-shot pool's ground-truth feed.
    if (!wasEdited) {
      await svc
        .from('so_scan_samples')
        .update({ corrected: s.extracted, status: SAMPLE_ACCEPTED })
        .eq('id', sampleId)
        .eq('status', SAMPLE_EXTRACTED);
      return;
    }

    // 4b. Edited — rebuild the operator's final values and store the pair.
    const [{ data: headerRow }, { data: itemRows }] = await Promise.all([
      svc.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle(),
      svc
        .from('mfg_sales_order_items')
        .select(SO_ITEM_COLS)
        .eq('doc_no', docNo)
        // Same ordering the SO detail read uses — line_no is the persisted
        // listing order (migration 0165); pre-0165 rows fall back to created_at.
        .order('line_no', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true }),
    ]);
    const corrected = buildCorrectedSlipFromSo(
      s.extracted,
      (headerRow as SoHeaderSnapshot | null) ?? null,
      ((itemRows as SoItemSnapshot[] | null) ?? []),
    );
    if (corrected === null) return;

    /* The edit may have touched only things the OCR does not emit (the venue,
       the note, a line price the pricing engine owns — see
       CARRIED_NOT_INVERTED). Then the rebuilt blob EQUALS `extracted`, and
       storing it would be a zero-diff CONFIRMED row: it teaches the distillers
       nothing and, inside their LIMIT window, evicts a real correction. Worse,
       downgrading it to ACCEPTED would assert "the AI read this correctly"
       about a draft a human had just edited. So we write NOTHING — exactly
       today's behaviour for an edited draft.
       Key order is preserved by construction (the blob is `extracted` spread
       and selectively overwritten), so a string compare is a safe deep compare
       here. */
    if (JSON.stringify(corrected) === JSON.stringify(s.extracted)) return;

    /* No-downgrade is inherent: the write is gated on status='EXTRACTED', so it
       can never bury a sample already CONFIRMED by the interactive endpoint.

       Deliberately NOT triggering the distillers here. POST /samples/:id/confirm
       fires them in waitUntil, but that route is a scan-owned surface; this one
       is the SO status transition, and hanging three sequential Anthropic calls
       off every DRAFT->CONFIRMED would put billed API traffic on a hot order
       path (and would need an import of scan-so.ts, which imports
       mfg-sales-orders.ts, which imports this module — a cycle). The weekly
       Sunday cron rebuild (backend/src/index.ts) is the backstop for the
       distilled rule layers, and the FEW-SHOT pool reads `corrected` live at
       extract time, so the sample takes effect on the very next scan. */
    await svc
      .from('so_scan_samples')
      .update({ corrected, status: SAMPLE_CORRECTED })
      .eq('id', sampleId)
      .eq('status', SAMPLE_EXTRACTED);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[scan-sample-review] review note failed (non-fatal):', docNo, (e as Error).message);
  }
}
