
import { isFreeItemLine } from './free-item-campaign';

const str = (v: unknown): string => {
  if (v == null) return '';
  return String(v).trim();
};

const specialsList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  const s = str(v);
  return s ? [s] : [];
};

/* ── Redundant-twin fold for the SPECIAL segment (2026-08-11) ───────────────
   The migrated-corpus backfill (backfill-specials-into-variants.mjs) is
   deliberately MERGE-ONLY and machine-asserts that it never removes a
   pre-existing entry — the owner's 不可以删只可以 cancel rule. So a line whose
   slip already carried the parser's own glued phrase now ALSO carries the
   picker code the backfill derived from it, and `variants.specials` legitimately
   holds both:

     ["BACKCUSHIONCHANGE8030", "Change 8030 Backcushion", "Wooden Arm"]
       → SPECIAL: BACKCUSHIONCHANGE8030 + Change 8030 Backcushion + Wooden Arm

   One request, printed twice. The data is correct and must not be touched, so
   the duplicate is resolved HERE, at the display layer, and nowhere else.

   The rule is deliberately narrow: only a SINGLE-TOKEN entry — a machine-glued
   or fragmentary string like `nylon`, `8030`, `NILONFABRIC`,
   `BACKCUSHIONCHANGE8030` — may ever be hidden, and only when another entry in
   the SAME list is a strictly richer twin of it (same identity, contains it, or
   is a re-ordering of its parts). An operator's multi-word request is therefore
   never hideable, so this can only ever suppress a machine artefact, never
   information. The identity is `skey` — the parsers' own dedupe key, letters and
   digits only with nilon≡nylon (scripts/lib/sofa-special-map.mjs, and the
   containment merge in backfill-specials-into-variants.mjs `phrasesOf`) — so the
   display agrees with the writer about what "the same phrase" means.

   Ranking picks the survivor: longer identity first (`Nylon Fabric` beats
   `nylon`), then more word-parts (the owner's spaced picker code
   `Change 8030 Backcushion` beats the glued `BACKCUSHIONCHANGE8030`), then
   original order. That is a strict total order, so the richest member of any
   twin group always survives and the segment can never be emptied.

   What this deliberately does NOT do: fold a SEMANTIC pair whose two strings
   share no letters — `NOSTICHINGINSITTINGAREA` beside `No notch on Seat Cushion`,
   `BACKRESTCHANGE8030` beside `Change 8030 Backcushion`. Deciding those needs the
   owner's phrase ruling (scripts/data/special-order-phrase-map.json), which is a
   Node-script data file read by two scripts and already hand-copied into
   scripts/lib/sofa-special-map.mjs with an admitted drift. Vendoring it into the
   Worker bundle AND the browser bundle to gain 26 production lines would make it
   a fourth and fifth copy of one ruling, so it is measured and reported instead
   of guessed at. Measured on production 2026-08-11: 216 of 1,051 lines carrying
   specials render a redundant twin that this fold removes; 26 more carry a
   semantic pair it deliberately leaves alone. */
const SPECIAL_ID = (s: string): string =>
  s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/NILON/g, 'NYLON');
const SPECIAL_PARTS = (s: string): string[] =>
  s.toUpperCase().replace(/NILON/g, 'NYLON').split(/[^A-Z0-9]+/).filter(Boolean);

const isReordering = (target: string, parts: string[]): boolean => {
  if (parts.length < 2 || !target) return false;
  if (parts.join('').length !== target.length) return false;
  const walk = (rest: string[], remaining: string): boolean => {
    if (rest.length === 0) return remaining === '';
    for (let i = 0; i < rest.length; i++) {
      if (!remaining.startsWith(rest[i])) continue;
      if (walk(rest.slice(0, i).concat(rest.slice(i + 1)), remaining.slice(rest[i].length))) return true;
    }
    return false;
  };
  return walk(parts, target);
};

/* ── Canonical special order (owner 2026-09-22) ─────────────────────────────
   Every line of a sofa SET must list the same add-ons in the SAME order — the
   compartment lines used to print them in whatever order the operator ticked
   them, so line 1 read "Backcushion Firmer + Nylon Fabric + Seat Base" while a
   sibling read them reversed. The fixed attribute segments (fabric / seat /
   divan / gap / leg) are already emitted in a fixed sequence by
   buildVariantSummary; this pins the ONE remaining free axis — the specials —
   to a deterministic order by sorting the labels.

   Codepoint comparison, NOT localeCompare: localeCompare is ICU-dependent and
   can differ between the Worker runtime and Node/test, which would defeat the
   whole point of a single canonical string. mfg-pricing-recompute imports the
   same comparator for the persisted `custom_specials` column, so the rendered
   SPECIAL segment and the stored composition can never disagree on order. */
export const compareSpecialLabels = (a: string, b: string): number =>
  (a < b ? -1 : a > b ? 1 : 0);

export const canonicalSpecialOrder = (labels: string[]): string[] =>
  labels.slice().sort(compareSpecialLabels);

export function foldRedundantSpecials(list: string[]): string[] {
  if (list.length < 2) return list;
  const info = list.map((v, i) => ({ v, i, id: SPECIAL_ID(v), n: SPECIAL_PARTS(v).length }));
  const richer = (b: typeof info[number], a: typeof info[number]): boolean =>
    (b.id.length !== a.id.length ? b.id.length > a.id.length : (b.n !== a.n ? b.n > a.n : b.i < a.i));
  return info
    .filter((a) => {
      if (!a.id || a.n !== 1) return true;
      return !info.some((b) => b !== a && b.id
        && (b.id === a.id || b.id.includes(a.id) || isReordering(a.id, SPECIAL_PARTS(b.v)))
        && richer(b, a));
    })
    .map((a) => a.v);
}

/**
 * Colour KIV (Loo 2026-06-12): the line committed to a fabric SERIES
 * (variants.fabricId / fabricLabel — its tier add-on is already charged) but
 * the COLOUR is confirmed later, so no colour-carrying key is filled yet.
 * This is the same state buildVariantSummary renders as "<series> COLOUR KIV":
 * a series commitment with none of fabricCode / colorCode / colourCode /
 * colourLabel / fabricColor present (the colour keys mirror the fabricCode
 * axis aliases in so-variant-rule plus the summary's colourLabel/fallbacks).
 *
 * A KIV line may SAVE freely — KIV is a legitimate sale-time state. What it
 * must NOT do is be RELEASED FOR ORDERING: the Processing-Date gate
 * (so-save-problems `fabric_colour_kiv`) blocks setting processing_date
 * while any non-cancelled line is still KIV (owner rule 2026-07-24, after an SO
 * was released with two KIV sofa lines and purchasing had nothing to order
 * against — a fabric series with no colour is not a thing anyone can buy).
 * A KIV placeholder colour (isKivColourCode) is KIV too.
 */
export function isColourKiv(
  variants: Record<string, unknown> | null | undefined,
): boolean {
  if (!variants || typeof variants !== 'object') return false;
  if ([variants.fabricCode, variants.colourId, variants.colorCode, variants.colourCode, variants.fabricColor]
    .some((code) => isKivColourCode(code))) return true;
  const committedSeries = str(variants.fabricId) || str(variants.fabricLabel);
  if (!committedSeries) return false;
  const colourConfirmed =
    str(variants.fabricCode) || str(variants.colorCode) || str(variants.colourCode)
    || str(variants.colourLabel) || str(variants.fabricColor);
  return !colourConfirmed;
}

/**
 * A KIV placeholder colour (owner 2026-10-30): a colour CODE whose last word is
 * KIV or TBC ("MAGIC Q KIV", "PC151-KIV"), kept in a series so a line can take
 * that series (its tier, and the Venture Portal's fabric upgrade charge and
 * KPI) before the customer picks the colour. It fills fabricCode, so without
 * this it would pass for a confirmed colour and the order could be released
 * for ordering against a colour nobody can buy.
 */
export function isKivColourCode(code: unknown): boolean {
  return /(?:^|[\s_-])(?:KIV|TBC)$/i.test(str(code));
}

/* A SUPERSEDED FABRIC ROW CARRIES ITS OWN OBITUARY, and it is not a
   specification. The fabric library renumbered itself on 2026-08-11 and left
   each old row in place with `[superseded by X on 2026-08-11]` written into
   the row's own LABEL — so a line still pointing at the dead row renders 39
   characters of bookkeeping in the middle of the specification the order is
   built to, and AutoCount then refuses the whole document for a Desc2 over its
   nvarchar(100) (HC-SO-012513 at 113, HC-SO-012629 at 117).

   THE SUCCESSOR WINS, which is the owner's ruling of 2026-09-09 (「遇到已被
   取代的颜色就用新色号」) and also the only reading that keeps the text true:
   the note names the code that replaced this one.

   SAFE AGAINST THE BOOK, measured rather than assumed: across the committed
   cutover snapshots — 60,939 SO lines, 18,148 PO lines, 47,329 DO lines —
   ZERO carry this note. It is ours alone, so removing it can only make our
   text agree with the book more often. That matters because
   autocount-line-keys.ts matches this string against the book's own Desc2 to
   tell one line from another. */
const SUPERSEDED_NOTE = /\s*\[\s*superseded\s+by\b\s*([^\]]*?)(?:\s+on\s+\d{4}-\d{2}-\d{2})?\s*\]/i;
export function liveColour(v: string): string {
  const m = SUPERSEDED_NOTE.exec(v);
  if (!m) return v;
  const successor = m[1].trim();
  return successor || v.replace(SUPERSEDED_NOTE, '').trim();
}

const FABRIC_CODE_KEYS = ['fabricCode', 'colorCode', 'colourCode', 'fabricColor'] as const;
export function fabricCodeOf(v: Record<string, unknown>): string {
  for (const k of FABRIC_CODE_KEYS) {
    const fc = str(v[k]);
    if (fc) return fc;
  }
  return '';
}

export function trustedFabricSupplierCode(v: Record<string, unknown>): string {
  const fc = fabricCodeOf(v);
  return fc && str(v.fabricSupplierCodeOf) === fc ? str(v.fabricSupplierCode) : '';
}

export function withFabricSupplierCode(v: Record<string, unknown>, supplierCode: string): Record<string, unknown> {
  return { ...v, fabricSupplierCode: supplierCode, fabricSupplierCodeOf: fabricCodeOf(v) };
}

export function withoutFabricSupplierCode(v: Record<string, unknown>): Record<string, unknown> {
  const { fabricSupplierCode: _code, fabricSupplierCodeOf: _of, ...rest } = v;
  return rest;
}

const COLOUR_LABEL_WORD = /^(?:COL|COLOU?R|CLR|FABRIC|FAB|CODE)$/;

function colourTokens(text: string): string[] {
  return text.toUpperCase()
    .replace(/([A-Z])(?=\d)|(\d)(?=[A-Z])/g, '$1$2 ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
}

function noteOnlyRestates(note: string, printed: string): boolean {
  const have = new Set(colourTokens(printed));
  const words = colourTokens(note).filter((t) => !COLOUR_LABEL_WORD.test(t));
  return words.length > 0 && words.every((t) => have.has(t));
}

/**
 * Build a one-line human summary of a line's variants.
 *
 * Format rules (see task spec, Commander 2026-05-28):
 *  - Fabric segment: [fabricCode, colorCode] (non-empty) joined with a space;
 *    BEDFRAME also appends the chosen colour name (colourLabel) → "BF-01 Sand".
 *  - BEDFRAME (itemGroup includes 'bedframe'): `DIVAN {divanHeight} + LEG {legHeight}`
 *    (bare "NO LEG" when no leg), then `GAP {gap}`, then `T.Heights {totalHeight}`.
 *  - SOFA (otherwise, when seat data present): `SEAT {seatHeight} {LEGHEIGHT}`.
 *  - Specials appended last, joined with ` + `.
 *  - All present segments joined with ` / `. Empty segments omitted.
 *  - Returns '' when nothing is present.
 */
export function buildVariantSummary(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
  opts?: { labelled?: boolean },
): string {
  if (!variants || typeof variants !== 'object') return '';

  const segments: string[] = [];

  const group = (itemGroup ?? '').toLowerCase();
  const isBedframe = group.includes('bedframe');

  // Fabric segment — fabricCode + colorCode joined by a space. BEDFRAME and
  // SOFA both append the chosen colour NAME (variants.colourLabel, e.g.
  // "BF-01 Sand") so the SO line shows the picked colour, not just the fabric
  // code (owner rule 2026-07-23 extending the 2026-06-03 bedframe rule to
  // sofa: "all option selections must show in the SO description").
  //
  // Supplier code (owner rule 2026-07-24, "orders 全部也是要补回去 ... 显示两个
  // code BF-01（PC151-01)"): when the line carries variants.fabricSupplierCode
  // (the supplier's own code for our internal fabric, stamped READ-side by the
  // SO/PO/DO/SI detail endpoints), append the supplier code in parens at the
  // END of the fabric segment — "CG-001 Pearl (KN390-1)" (format ruling below). Read off variants (the file's convention: new fields
  // read off variants, missing -> old behaviour), so a line with no supplier code
  // is unchanged. Distinct-only: a supplier code equal to the internal code adds
  // no parens.
  const fabricCodeRaw = liveColour(str(variants.fabricCode));
  const fabricSupplierCode = trustedFabricSupplierCode(variants);
  // Owner format ruling 2026-07-24 (second pass): the supplier code's parens
  // go at the END of the whole fabric segment - "CG-001 Pearl (KN390-1)" -
  // NEVER inline after the bare code ("CG-001 (KN390-1) CG-001 Pearl" was the
  // duplicated mess, and "CG-001 (KN390-1) Pearl" was still the wrong order).
  // So the parts are composed BARE (the original dedupe rules all hold) and
  // the parens are appended to the finished segment below.
  const fabricParts = [fabricCodeRaw, str(variants.colorCode), str(variants.colourLabel)].map(liveColour);
  const presentFabric = fabricParts.filter(Boolean);
  const dedupedFabric = presentFabric.filter((p, i) =>
    !presentFabric.some((q, j) => j !== i && q !== p && (
      q.startsWith(`${p} `) || q.startsWith(`${p}(`)
      || q.endsWith(` ${p}`)
    )),
  );
  let fabric = [...new Set(dedupedFabric)].join(' ')
    || str(variants.fabricColor)
    || (str(variants.fabricLabel) ? `${str(variants.fabricLabel)} COLOUR KIV` : '');
  // Supplier code (owner rule 2026-07-24): appended LAST, in parens, when the
  // line carries a distinct variants.fabricSupplierCode - "CG-001 Pearl
  // (KN390-1)". A line with no supplier code is unchanged.
  if (fabric && fabricSupplierCode && fabricSupplierCode !== fabricCodeRaw) {
    fabric = `${fabric} (${fabricSupplierCode})`;
  }
  if (fabric) segments.push(opts?.labelled ? `Fabric: ${fabric}` : fabric);

  const leg = (str(variants.legHeight) || str(variants.sofaLegHeight)).toUpperCase();

  if (isBedframe) {
    const divan = str(variants.divanHeight);
    const legLabel = leg ? (/^NO\s*LEG$/.test(leg) ? leg : `LEG ${leg}`) : '';
    if (divan || legLabel) {
      const divanPart = divan ? `DIVAN ${divan}` : '';
      segments.push([divanPart, legLabel].filter(Boolean).join(' + '));
    }
    const gap = str(variants.gap);
    if (gap) segments.push(`GAP ${gap}`);
    const total = str(variants.totalHeight);
    if (total) segments.push(`T.Heights ${total}`);
  } else {
    const seat = str(variants.seatHeight) || str(variants.depth);
    if (seat) segments.push(`SEAT ${seat}`);
    if (leg)  segments.push(`LEG ${leg}`);
  }

  // Special orders always appended last, labelled so they read clearly in the
  // combined "Description 2" string (Commander 2026-05-28: "还要加 special order").
  // Special Add-ons (migration 0134): when the line carries variants.specialChoices
  // ({ code: [chosen option-group labels] }), append the picked choices after each
  // code — e.g. "SPECIAL: Right Drawer (10") + Back Cover". Read straight off
  // `variants` so no caller signature changes; missing → codes-only (old orders).
  // foldRedundantSpecials: one request must print once — see the rule above.
  // The stored array is untouched; only this rendering drops the glued twin.
  /* RECORDED-ONLY specials (owner's choice 甲, 2026-09-03). An AutoCount-imported
     line's Desc2 asked for a PRICED option; recording it must make that option
     VISIBLE on every printed copy without re-charging a historical document, so
     the codes live in `variants.specialsRecorded` — a key NO pricing path reads
     — and are rendered HERE beside the picked ones. Deliberately merged into the
     same SPECIAL segment: whoever makes the item needs ONE list of the customer's
     requests, not two. A code the operator has since picked properly wins, so it
     is never printed twice. See
     docs/bugs/0636-298-migrated-lines-lost-their-special-order-because-recordin.md
     and backend/scripts/record-priced-specials-on-migrated-lines.mjs. */
  const picked = foldRedundantSpecials(specialsList(variants.specials ?? variants.special));
  const recordedRaw = specialsList(variants.specialsRecorded)
    .filter((c) => !picked.some((p) => p.toLowerCase() === c.toLowerCase()));
  // Owner 2026-09-22: print the add-ons in ONE canonical order so a sofa SET's
  // compartment lines match each other and match the persisted custom_specials.
  // Sorted WITHIN each group, not across: the picked add-ons still print before
  // the recorded-only ones (owner's choice 甲, 2026-09-03), and the free-text
  // extra add-on NOTE is pushed onto specialBits AFTER this, so it always trails.
  const specials = [...canonicalSpecialOrder(picked), ...canonicalSpecialOrder(recordedRaw)];
  const choicesMap =
    variants.specialChoices && typeof variants.specialChoices === 'object'
      ? (variants.specialChoices as Record<string, unknown>)
      : null;
  const specialBits = specials.map((code) => {
    const chosen = choicesMap ? specialsList(choicesMap[code]) : [];
    return chosen.length ? `${code} (${chosen.join(', ')})` : code;
  });
  const extraRM = Math.round(Number(variants.extraAddonAmountRM ?? 0));
  const noteText = str(variants.extraAddonNote);
  /* A note that only restates the printed colour is not a second instruction
     (2026-09-15: the Sofa Accessory data run wrote fabricCode from the note, so
     HC-SO-013503 read "COVE-13 / SPECIAL: Col : cove 13"). Dropped only when
     EVERY word of it is already in the fabric segment and nothing is charged
     for it; a note with anything more prints whole, so a disagreeing code is
     never hidden. docs/bugs/0934-a-special-order-note-that-only-repeats-the-line-s-colour-pri.md. */
  const noteRestatesFabric = noteText !== '' && extraRM <= 0 && fabric !== ''
    && noteOnlyRestates(noteText, fabric);
  if ((noteText && !noteRestatesFabric) || extraRM > 0) {
    specialBits.push(noteText || 'Extra add-on');
  }
  if (specialBits.length) segments.push(`SPECIAL: ${specialBits.join(' + ')}`);

  if (isFreeItemLine(variants)) {
    const freeItem = variants.freeItem as { campaignName?: unknown } | undefined;
    const name = str(freeItem?.campaignName);
    segments.push(name ? `FREE · ${name}` : 'FREE');
  }

  return segments.filter(Boolean).join(' / ');
}
