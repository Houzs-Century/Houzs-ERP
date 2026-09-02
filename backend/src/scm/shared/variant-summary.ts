// Variant summary — Commander 2026-05-28.
// Pure helper that merges a SO/PO line's variant object into ONE human-readable
// string in HOOKKA style, e.g.
//   `PC151-01 / DIVAN 10" + NO LEG / GAP 14" / T.Heights 24"`
// Same code runs on POS, Backend, and Workers (no DOM, no module state).

import { isFreeItemLine } from './free-item-campaign';

/** Coerce a single variant value to a trimmed display string ('' when empty). */
const str = (v: unknown): string => {
  if (v == null) return '';
  return String(v).trim();
};

/** Normalise variants.specials (string[] | string) → trimmed non-empty list. */
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

/** Can `target` be built by concatenating ALL of `parts` in some order? */
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

export function foldRedundantSpecials(list: string[]): string[] {
  if (list.length < 2) return list;
  const info = list.map((v, i) => ({ v, i, id: SPECIAL_ID(v), n: SPECIAL_PARTS(v).length }));
  const richer = (b: typeof info[number], a: typeof info[number]): boolean =>
    (b.id.length !== a.id.length ? b.id.length > a.id.length : (b.n !== a.n ? b.n > a.n : b.i < a.i));
  return info
    .filter((a) => {
      if (!a.id || a.n !== 1) return true; // only a glued/fragmentary entry is hideable
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
 */
export function isColourKiv(
  variants: Record<string, unknown> | null | undefined,
): boolean {
  if (!variants || typeof variants !== 'object') return false;
  const committedSeries = str(variants.fabricId) || str(variants.fabricLabel);
  if (!committedSeries) return false;
  const colourConfirmed =
    str(variants.fabricCode) || str(variants.colorCode) || str(variants.colourCode)
    || str(variants.colourLabel) || str(variants.fabricColor);
  return !colourConfirmed;
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
  /* labelled — prefix the fabric segment with "Fabric: " on supplier-facing
     docs (PO / GRN / PI). Seat/Leg/Divan/Gap already carry inline labels; the
     fabric code was the only bare segment. Default off → POS/SO unchanged. */
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
  const fabricCodeRaw = str(variants.fabricCode);
  const fabricSupplierCode = str(variants.fabricSupplierCode);
  // Owner format ruling 2026-07-24 (second pass): the supplier code's parens
  // go at the END of the whole fabric segment - "CG-001 Pearl (KN390-1)" -
  // NEVER inline after the bare code ("CG-001 (KN390-1) CG-001 Pearl" was the
  // duplicated mess, and "CG-001 (KN390-1) Pearl" was still the wrong order).
  // So the parts are composed BARE (the original dedupe rules all hold) and
  // the parens are appended to the finished segment below.
  const fabricParts = [fabricCodeRaw, str(variants.colorCode), str(variants.colourLabel)];
  // Dedupe — when the colour label/code is just the fabric code again (e.g.
  // BF-07 whose colour label is also "BF-07"), don't repeat it ("BF-07 BF-07").
  // GRN / PI / PR / Stock-Adjustment editors store the fabric under fabricColor;
  // fall back to it when the SO-style keys are empty so received lines still show
  // their fabric in the Description 2 summary.
  // Colour KIV (Loo 2026-06-12): the customer committed to a fabric SERIES
  // (variants.fabricId/fabricLabel — its tier add-on is already charged) but
  // confirms the colour later, so there's no fabricCode yet. Surface the
  // series + the open colour so the doc line reads the true state.
  // Drop a bare part that a RICHER part already leads with (at a token
  // boundary), so an enriched fabric code "BF-12 (PC151-12)" doesn't get the
  // bare colour label "BF-12" repeated after it → "BF-12 (PC151-12) BF-12"
  // (Commander 2026-06-19). Exact repeats still drop via the Set.
  const presentFabric = fabricParts.filter(Boolean);
  const dedupedFabric = presentFabric.filter((p, i) =>
    !presentFabric.some((q, j) => j !== i && q !== p && (
      // a richer part LEADS with the bare part — "BF-12 (PC151-12)" vs "BF-12"
      q.startsWith(`${p} `) || q.startsWith(`${p}(`)
      // Houzs 2026-06-23 — or a richer part already ENDS with it: the fabric code
      // contains the colour ("A201-7-LIGHT BROWN" + derived colour "BROWN") → drop
      // the redundant trailing colour so the line shows just the code, not
      // "A201-7-LIGHT BROWN BROWN". A genuinely separate colour ("BF-01" + "Sand")
      // is NOT a trailing token of the code, so it still shows.
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

  // 2026-06-04 — POS handover sofa lines carry the leg pick as sofaLegHeight
  // (PR #473) and the seat pick as depth; Backend-keyed lines use legHeight /
  // seatHeight. Same axes, two vocabularies (see so-variant-rule) — read both
  // so POS-created SO/GRN/PO lines show their SEAT / LEG segments too.
  const leg = (str(variants.legHeight) || str(variants.sofaLegHeight)).toUpperCase();

  if (isBedframe) {
    // BEDFRAME: DIVAN {divan} + LEG {leg} / GAP {gap} / T.Heights {total}.
    // The leg carries an explicit "LEG" label so it isn't misread as part of
    // the divan figure (was "DIVAN 10\" + 1\"" → now "DIVAN 10\" + LEG 1\"");
    // "No Leg" reads as-is without the redundant prefix (Loo, 2026-06-03).
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
    // SOFA: SEAT {seat} / LEG {LEG}
    // Commander 2026-05-29: use the SAME ` / ` delimiter as every other segment
    // so the summary reads with ONE consistent separator (was mixing ` / ` with
    // a ` · ` inside the seat·leg token → "BF-01 / SEAT 24 · LEG 6\"").
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
     line's Desc2 asked for a PRICED option; recording it must let the factory
     see what to build without re-charging a historical document, so the codes
     live in `variants.specialsRecorded` — a key NO pricing path reads — and are
     rendered HERE beside the picked ones. Deliberately merged into the same
     SPECIAL segment: the factory needs one list of what to build, not two.
     A code the operator has since picked properly wins, so it is never printed
     twice. See docs/bugs/ "recorded, not charged" and
     backend/scripts/record-priced-specials-on-migrated-lines.mjs. */
  const picked = foldRedundantSpecials(specialsList(variants.specials ?? variants.special));
  const recordedRaw = specialsList(variants.specialsRecorded)
    .filter((c) => !picked.some((p) => p.toLowerCase() === c.toLowerCase()));
  const specials = [...picked, ...recordedRaw];
  const choicesMap =
    variants.specialChoices && typeof variants.specialChoices === 'object'
      ? (variants.specialChoices as Record<string, unknown>)
      : null;
  const specialBits = specials.map((code) => {
    const chosen = choicesMap ? specialsList(choicesMap[code]) : [];
    return chosen.length ? `${code} (${chosen.join(', ')})` : code;
  });
  // Loo 2026-06-13 — the POS product-page "special add-on" (note + extra charge,
  // variants.extraAddonNote + extraAddonAmountRM) is a FREE-TEXT Special Add-on.
  // Its NOTE renders in the same SPECIAL segment as the picked add-ons so
  // Description 2 reads them together. The item remark (variants.remark) is a
  // SEPARATE field and does NOT belong here — it prints as its own "Remark:"
  // line off the mfg_sales_order_items.remark column.
  //
  // Loo 2026-06-15 — the add-on AMOUNT is no longer surfaced here. It is already
  // folded into the line's selling price (POS submit + recompute extraSen fold),
  // so printing "(+RM…)" double-shows money that's already in the product amount.
  // The SPECIAL segment keeps the note label ("Extra add-on" by default) so the
  // add-on stays visible — only the RM figure is dropped.
  const extraRM = Math.round(Number(variants.extraAddonAmountRM ?? 0));
  const noteText = str(variants.extraAddonNote);
  if (noteText || extraRM > 0) {
    specialBits.push(noteText || 'Extra add-on');
  }
  if (specialBits.length) segments.push(`SPECIAL: ${specialBits.join(' + ')}`);

  // Free Item Campaign (migration 0176, 2026-06-17) — a line made free by a
  // campaign carries variants.freeItem.campaignId (stamped server-side). Surface
  // the campaign name so every customer doc reads "FREE · <campaign name>" or
  // simply "FREE" when the campaign name is blank. This segment prints LAST so
  // existing SEAT/LEG/SPECIAL segments remain unchanged.
  if (isFreeItemLine(variants)) {
    const freeItem = variants.freeItem as { campaignName?: unknown } | undefined;
    const name = str(freeItem?.campaignName);
    segments.push(name ? `FREE · ${name}` : 'FREE');
  }

  return segments.filter(Boolean).join(' / ');
}
