// ----------------------------------------------------------------------------
// refusal-detail — turn a refusal that ALREADY CARRIES THE ANSWER into a
// sentence the person on the shop floor can act on.
//
// THE BUG THIS EXISTS FOR. A salesperson could not add a BEDFRAME line to an
// existing Sales Order. All he saw was:
//
//   "Save failed. Could not save <SKU>: Some of the details weren't accepted.
//    Please check what you entered and try again."
//
// The server had already told us everything. `variant_not_allowed` ships
// `field`, `value` and `allowed` (backend allowed-options-check.ts:81-86), and
// the client discarded all three: the code is in no curated map, the body has
// neither `reason` nor `message`, so `humanApiError` fell to its 400 catch-all.
// This is not a "go find out what is wrong" fix. It is a "stop discarding what
// we were already told" fix.
//
// WHY IT LIVES ON THE ERROR PATH AND NOT ON THE PAGE. `err.body` does not
// survive a line write. so-add-lines.ts:115-116 `messageOf` keeps only
// `e.message`; :130/:159 push `{label, message}`; :186/:190 throw a BARE Error.
// By the time SalesOrderDetail.tsx:1022/:1028 look for `.body` it is
// `undefined` — which is also why the `problems` modal and the version-conflict
// recovery are already dead for add / update / delete. Composing the sentence
// here is the only shape that reaches the screen.
//
// TWO RULES THE OWNER SET, both enforced below.
//   · A message may not assert something the code cannot establish. So an
//     unmapped field name is DROPPED, never guessed at and never printed raw.
//   · Messages are written from the operator's side of the screen. `size_code`,
//     `total_heights` and `compartment` are column names, not words a
//     salesperson uses; every label here is copied from the control he is
//     actually looking at, cited at its definition.
// ----------------------------------------------------------------------------
import { normaliseTypographicQuotes } from '../../shared/mfg-pricing';

/** What the form calls each thing the allowed-options gate can refuse.
 *
 *  EVERY string here is the word already on the screen — one name per thing,
 *  because two words for one thing is this codebase's repeat offender:
 *    Fabric        SoLineCard.tsx:930  label="Fabrics"
 *    Gap           SoLineCard.tsx:938  label="Gaps"
 *    Divan Height  SoLineCard.tsx:945  label="Divan Heights"
 *    Leg Height    SoLineCard.tsx:952  label="Leg Heights"
 *    Seat Size     SoLineCard.tsx:1062 label="Seat Size"
 *    Total Height  SoLineCard.tsx:958  "Total height (auto): … (Divan + Leg + Gap)"
 *    Size          Products.tsx:713 `label: 'Size'`, ProductModelDetail.tsx:717 <th>Size</th>
 *    Compartment   ProductModelDetail.tsx:1183 label="Compartments"
 *    Special Order SoLineCard.tsx:961 <SpecialOrders> — the section is plural,
 *                  one pick is singular.
 *  A field NOT in this map is rendered without a name at all (see below). */
const FIELD_LABEL: Record<string, string | undefined> = {
  fabric:       'Fabric',
  gap:          'Gap',
  divan_height: 'Divan Height',
  leg_height:   'Leg Height',
  seat_size:    'Seat Size',
  total_height: 'Total Height',
  size_code:    'Size',
  compartment:  'Compartment',
  specials:     'Special Order',
};

/** Fields that are NOT a box on the Sales Order line, so "pick a different
 *  value" would send the operator hunting for a control that isn't there.
 *
 *  `size_code` is a COLUMN ON THE PRODUCT ROW (allowed-options-check.ts:122-137
 *  reads `product.size_code`, never the line's variants), and `compartment` for
 *  a hand-keyed sofa line is SLICED OUT OF THE SKU (:170-171). Both are decided
 *  by which item was picked, so the only real remedy is a different item. */
const FROM_THE_ITEM_CODE: Record<string, string | undefined> = {
  size_code:   'the item code',
  compartment: 'the item code and the sofa build',
};

/** Longest list we will read out. Every pool measured on prod is well inside
 *  this (total_heights 16, gaps 17, fabrics 18, sizes 6); the cap only stops a
 *  pathological pool from turning the banner into a wall of text. */
const MAX_LISTED = 20;

/** Join for a human: "a, b or c". */
const readOut = (values: string[]): string => {
  const shown = values.slice(0, MAX_LISTED);
  const tail = values.length - shown.length;
  const joined = shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1]}`;
  return tail > 0 ? `${joined} (and ${tail} more)` : joined;
};

/* THE POOL IS PRINTED FOLDED, AND THAT IS NOT COSMETIC.
   Prod's one BEDFRAME `total_heights` pool stores its even values with an ASCII
   inch mark and 17/19/21/23/25/27 with U+201C / U+201D (measured 2026-08-17,
   probe run 32048732641). Printed verbatim beside an ASCII value, the message
   reads `Total height 17" … allowed: 17“, 19“` — look-alike glyphs, which an
   operator reads as gibberish or as a system bug. Folding to the ASCII form the
   editor emits (the SAME `normaliseTypographicQuotes` the pricing engine and
   now the gate itself use — one definition, vendored) makes the list say what
   it means. De-duplicating afterwards stops one number appearing twice when a
   pool happens to hold both spellings. */
const forDisplay = (values: string[]): string[] => {
  const out: string[] = [];
  for (const v of values) {
    const folded = normaliseTypographicQuotes(String(v)).trim();
    if (folded && !out.includes(folded)) out.push(folded);
  }
  return out;
};

/** The refusal shapes this renders. Deliberately structural, not a list of
 *  error codes: ANY body that names the input, the value and the pool can be
 *  said out loud, so a refusal minted next month renders with no edit here.
 *  That is the point — today's repeated defect in this repo is a rule expressed
 *  at N call sites and present at N-1. */
type RefusalBody = {
  field?:   unknown;
  value?:   unknown;
  allowed?: unknown;
  derivedFrom?: unknown;
};

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const strArray = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];

/** Compose the operator's sentence, or null when the body cannot be said
 *  honestly — in which case the caller keeps its existing generic message.
 *
 *  Returns null when there is no `field`+`value` pair or no non-empty pool.
 *  That exclusion is deliberate rather than lazy: `invalid_variant_key` ships
 *  `{key, allowed}` where `allowed` is a list of camelCase WIRE KEYS, and
 *  reading those out to a salesperson breaks the same rule this file exists to
 *  keep. A refusal that names only a set, without naming what was rejected,
 *  cannot be turned into a sentence — so it stays generic. */
export function describeRefusal(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as RefusalBody;

  const field = str(body.field);
  const value = normaliseTypographicQuotes(str(body.value)).trim();
  const allowed = forDisplay(strArray(body.allowed));
  if (!field || !value || allowed.length === 0) return null;

  const label = FIELD_LABEL[field] ?? null;
  const list = readOut(allowed);

  /* ── DERIVED FIELD ─────────────────────────────────────────────────────
     The bedframe case, and the reason a naive fix would have been useless.
     `total_height` is arithmetic — divan + leg + gap, computed at
     SoLineCard.tsx:430-437 and written into the draft at :439-445 — and the
     form has NO Total Height input (:950-960 renders it as read-only text).
     So "Total Height 17" is not allowed" names a field he cannot edit and
     leaves him exactly as stuck. Name the boxes he CAN move, and the number
     they have to reach. */
  const parts = Array.isArray(body.derivedFrom)
    ? (body.derivedFrom as unknown[])
        .filter((p): p is { field?: unknown; value?: unknown } => !!p && typeof p === 'object')
        .map((p) => ({
          label: FIELD_LABEL[str(p.field)] ?? null,
          value: normaliseTypographicQuotes(str(p.value)).trim(),
        }))
        .filter((p) => p.label !== null) as Array<{ label: string; value: string }>
    : null;

  if (parts && parts.length > 0 && label) {
    const names = readOut(parts.map((p) => p.label));
    const filled = parts.filter((p) => p.value);
    const sum = filled.length > 0
      ? ` (${filled.map((p) => `${p.label} ${p.value}`).join(' + ')})`
      : '';
    return (
      `${label} works out to ${value}${sum}, which this model doesn't offer. `
      + `There is no ${label} box on the line — change ${names} `
      + `so they add up to one of ${list}.`
    );
  }

  /* ── NOT A BOX ON THE LINE ────────────────────────────────────────────── */
  const source = FROM_THE_ITEM_CODE[field];
  if (source && label) {
    return (
      `This item is ${label} ${value}, which this model doesn't offer. `
      + `${label} comes from ${source}, not a box on the line — pick a different item. `
      + `This model offers ${list}.`
    );
  }

  /* ── A BOX HE CAN CHANGE ──────────────────────────────────────────────── */
  if (label) {
    return `${label} ${value} isn't offered on this model. Pick one of ${list}.`;
  }

  /* ── UNKNOWN FIELD ────────────────────────────────────────────────────
     A field we have no screen-word for. The raw name is a column name by
     default in this codebase, and the owner ruling bars those from operator
     text, so it is DROPPED — the value and the pool still make the message
     actionable, and nothing is asserted that the code cannot establish. */
  return `${value} isn't one of the values this model offers. Pick one of ${list}.`;
}
