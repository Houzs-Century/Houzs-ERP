// ---------------------------------------------------------------------------
// Do two ERP rows name the SAME FABRIC COLOUR? — and, just as important, when
// can we not tell?
//
// WHY THIS EXISTS. `probe-link-identity.mjs` reported "12 rows across 7
// documents carry a colour that disagrees with the line they were copied from"
// by comparing
//     coalesce(variants->>'colourId', variants->>'colourLabel', variants->>'colourCode')
// on both sides. Those are THREE DIFFERENT VOCABULARIES.
// `import-ac-outstanding-so.mjs` writes colourId AND colourLabel together at
// :304 and colourLabel ALONE at :317, so a row from the second path compared
// against a row from the first compares an ID against a human label and
// disagrees BY CONSTRUCTION. It is the same mistake as the `colourCode` one
// that section had already been corrected for, one layer up: a check that
// answers a different question.
//
// The enumeration (probe-invoice-link-facts.mjs, run 34143079454, 2026-09-08
// 00:26 local) printed all three fields on both sides for every disagreeing
// row. NOT ONE of them was two different fabrics. They were:
//
//   * 8 rows where both sides carry a colourId and ONE OF THEM IS SUPERSEDED —
//     the fabric library renumbered itself on 2026-08-11 and left the old row
//     in place with "[superseded by X on 2026-08-11]" written into its own
//     label. `CH141-8` vs `CH141-08`, `BO315-5-FOSSIL` vs `BO315-05`,
//     `KS-01 BABY WHITE` vs `KS-01`.
//   * 6 rows where one side has an id and the other only a free-text label,
//     differing in punctuation, spacing or spelling: `MODENZA 05- DARK OLIVE`
//     vs `MODENZA-05 DARK OLIVE`, `J9883-1-1 PAMA` vs `J9883-1-01`,
//     `grafield1-softlinen` vs `GARFIELD-01 SOFT LINEN`.
//
// SO THE VERDICT HAS THREE VALUES, NOT TWO. 'same' and 'different' cannot
// express the last case honestly: `grafield1-softlinen` is almost certainly
// GARFIELD-01 with a transposed letter, but a string rule cannot PROVE that,
// and answering 'different' would send somebody to edit a row that is probably
// right. The third value is 'unproven', and it is the answer this module gives
// whenever the two sides cannot be shown equal by supersession or by
// punctuation.
//
// NO SHEBANG: a test imports this file (Windows vitest inlines the source).
// ---------------------------------------------------------------------------

/** Strip everything that is not a letter or a digit, and upper-case. Turns
 *  `MODENZA 05- DARK OLIVE` and `MODENZA-05 DARK OLIVE` into one string, which
 *  is the whole punctuation class. It does NOT bridge a spelling difference or
 *  a zero-padding difference, deliberately — see 'unproven' above. */
export const canonicalColour = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

/** The colour id a superseded fabric row points at, or null.
 *  The library writes the pointer into the row's own LABEL, e.g.
 *  `CH141-8 [superseded by CH141-08 on 2026-08-11]`. */
export function supersededBy(label) {
  const m = /\[\s*superseded\s+by\s+([^\]]*?)(?:\s+on\s+\d{4}-\d{2}-\d{2})?\s*\]/i.exec(String(label ?? ''));
  return m ? m[1].trim() : null;
}

/**
 * Follow supersession to the live colour id.
 * @param {string|null} id
 * @param {Map<string,string>} labelById colour_id -> label, the fabric library
 * @param {number} maxHops guards a library that points at itself
 */
export function liveColourId(id, labelById, maxHops = 5) {
  let cur = id == null ? null : String(id).trim();
  const seen = new Set();
  for (let i = 0; cur && i < maxHops; i += 1) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const next = supersededBy(labelById.get(cur));
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * @param {{colourId?: string|null, colourLabel?: string|null, colourCode?: string|null}} a
 * @param {{colourId?: string|null, colourLabel?: string|null, colourCode?: string|null}} b
 * @param {Map<string,string>} labelById the fabric library, colour_id -> label
 * @returns {{verdict: 'same'|'different'|'unproven', why: string}}
 *
 * 'different' is reserved for the one case a string rule CAN establish: both
 * sides carry a colour id, both resolve through supersession, and the two live
 * ids are not the same row. Everything else that is not provably equal is
 * 'unproven', because a comparison across two vocabularies has not measured a
 * colour at all.
 */
export function compareColour(a, b, labelById) {
  const aId = a?.colourId ?? null;
  const bId = b?.colourId ?? null;
  const aText = a?.colourLabel ?? a?.colourCode ?? null;
  const bText = b?.colourLabel ?? b?.colourCode ?? null;

  if (aId && bId) {
    const la = liveColourId(aId, labelById);
    const lb = liveColourId(bId, labelById);
    if (la === lb) {
      return { verdict: 'same', why: la === String(aId).trim() && lb === String(bId).trim()
        ? 'the same colour id'
        : `both resolve to ${la} once the 2026-08-11 supersession is followed` };
    }
    /* One more chance before calling it different: the two LABELS may be the
       same colour written two ways, which happens when one side stored the
       label text into the id field. */
    if (canonicalColour(labelById.get(la) ?? la) === canonicalColour(labelById.get(lb) ?? lb)) {
      return { verdict: 'same', why: `${la} and ${lb} carry the same colour name` };
    }
    return { verdict: 'different', why: `two live colour ids, ${la} and ${lb}` };
  }

  /* A colour id on one side and free text on the other is NOT a measurement of
     a colour. It can only be resolved upward — to 'same' — never downward. */
  const aKey = canonicalColour(aId ?? aText);
  const bKey = canonicalColour(bId ?? bText);
  if (aKey && bKey && aKey === bKey) {
    return { verdict: 'same', why: 'the same text once punctuation and case are removed' };
  }
  /* The library may name the id's row, in which case the free text can be
     matched against that name. */
  const aName = canonicalColour(aId ? (labelById.get(String(aId).trim()) ?? '') : (aText ?? ''));
  const bName = canonicalColour(bId ? (labelById.get(String(bId).trim()) ?? '') : (bText ?? ''));
  if (aName && bName && aName === bName) {
    return { verdict: 'same', why: 'the same colour name once punctuation and case are removed' };
  }
  return {
    verdict: 'unproven',
    why: (aId && !bId) || (bId && !aId)
      ? 'one side carries a colour ID and the other only free text — this comparison has not measured a colour'
      : 'neither side resolves to a library row, and the two texts are not the same string',
  };
}
