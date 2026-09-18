// ----------------------------------------------------------------------------
// Abbreviate a Description 2 ON THE WAY OUT, and never in the data.
//
// WHY THIS EXISTS INSTEAD OF THE OBVIOUS THING. AutoCount refuses a whole
// document whose Desc2 is over nvarchar(100), and six lines on three sales
// orders are over. The obvious fix — shorten the text the ERP stores — was
// built, planned against production, and then abandoned when the plan showed
// what it would touch:
//
//   `variants.specials` is read by mfg-pricing.ts (10 places),
//   mfg-pricing-recompute.ts (5) and po-pricing.ts (1), and a special is priced
//   by NAME: `findOption(pool, p)`, with the comment "Unknown picks contribute
//   0". Renaming `HB Fully Cover` to `HB FC` unmatches it, its surcharge becomes
//   zero, and `recomputeOneLine` runs when the document is saved.
//
// So shortening the stored text is a PRICE CHANGE on a live sales order. The
// owner approved the wordings, not a repricing, and a fix that quietly moves
// money is not a fix.
//
// THE SHAPE THAT IS SAFE: the ERP keeps `HB Fully Cover`, the screen and the
// PDF keep `HB Fully Cover`, pricing keeps finding `HB Fully Cover` — and only
// the string handed to AutoCount is abbreviated, at the last moment, and only
// when it does not otherwise fit.
//
// THE ABBREVIATIONS ARE THE OWNER'S OWN, written by him on 2026-09-09 while
// cutting these six lines by hand. They are not invented here.
// ----------------------------------------------------------------------------

/**
 * The owner's abbreviations, longest first so a longer phrase is never eaten by
 * a shorter one inside it (`Divan Full Cover` must not be reached by the rule
 * for `Full Cover`).
 *
 * Every entry is a phrase he wrote himself. Adding one is a decision about what
 * the workshop will still recognise, so it belongs to him and not to a regex.
 */
export const DESC2_ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bDivan Full Cover\b/gi, 'Divan FC'],
  [/\bHB back fully covered\b/gi, 'HB back fully cover'],
  [/\bHB Fully Cover\b/gi, 'HB FC'],
  [/\bRight Drawer\b/gi, 'R Drawer'],
  [/\bLeft Drawer\b/gi, 'L Drawer'],
  [/\bFully Cover\b/gi, 'F.Cover'],
];

/* WHY THERE IS NO BARE `Drawer` -> `Dwr` RULE. It was written and removed the
   same hour. The abbreviations run over the WHOLE string, and a bare,
   case-insensitive `Drawer` reaches into an add-on's prose as well as a picker's
   name: HC-SO-007678's note came out as "one Dwr on the left and one Dwr on the
   right". Every rule above names a WHOLE PHRASE somebody picked, which is the
   property that stops it happening. A test pins it. */

/**
 * Shorten `text` only as far as it must be, and only if it is over `max`.
 *
 * THREE RULES, and the first is what keeps this from touching anything that
 * works today:
 *
 * 1. **A string that already fits is returned UNCHANGED, by identity.** Nothing
 *    that reaches AutoCount today reaches it differently tomorrow.
 * 2. **The abbreviations are applied IN ORDER and it stops the moment it fits.**
 *    A line that only needs `Drawer` shortened does not also lose `Fully Cover`
 *    — the least abbreviation that works is the one that is sent.
 * 3. **It NEVER truncates.** A string still over the column after every
 *    abbreviation comes back as it was, and the caller refuses the document
 *    exactly as it does today. Half a specification is a wrong instruction, not
 *    a short one.
 */
export function abbreviateDesc2(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text;
  for (const [pattern, short] of DESC2_ABBREVIATIONS) {
    out = out.replace(pattern, short);
    if (out.length <= max) return out;
  }
  /* THE LAST RUNG, and it is the owner's decision rather than a heuristic: the
     special order does not have to reach AutoCount at all. */
  const pointed = pointSpecialsAtTheErp(out);
  if (pointed.length <= max) return pointed;
  /* Still over even with the specials replaced by a pointer, so the length is
     in the build or the colour and no rung here can reach it. Return the
     SHORTENED text: it is the same specification in the owner's own words, and
     the caller's refusal then reports the length that is actually the problem. */
  return out;
}

/**
 * THE OWNER'S OWN SENTENCE, 2026-09-10. Do not reword it.
 *
 * 「你可以写说 "Special Order: Refer to ERP"。那 Special Order 就不需要进去
 * Auto Call 那边了,然后就没问题了。」
 *
 * It is a POINTER, not a summary, and that distinction is the whole reason this
 * is allowed where truncation is not. Half a specification reads as a complete
 * instruction and builds the wrong furniture; a sentence that says "the
 * specification is in the ERP" cannot be mistaken for one.
 */
export const SPECIAL_ORDER_POINTER = 'Special Order: Refer to ERP';

/** The segment separator `buildVariantSummary` and `composeSofaDesc2` both use. */
const SEGMENT = ' / ';

/**
 * Replace the SPECIAL segment of a composed Description 2 with the pointer.
 *
 * WHY THE OWNER ALLOWS THIS AT ALL, in his words on 2026-09-10: 「反正我们没有用
 * Auto Call 的 PO 那些,用 Auto Call 只是因为我要平行跑这个系统 ... 最重要是每一
 * 张单都可以进到就行了。」 AutoCount is a parallel run; the factory builds from
 * the ERP and the PDF. So the special order is not load-bearing THERE, and a
 * document that reaches the book with a pointer is worth more than a document
 * that reaches nothing with the full text.
 *
 * SEGMENT-BOUNDED, never "everything after SPECIAL:". A `FREE - <campaign>`
 * segment prints AFTER the special one and is a different fact about the line;
 * cutting to the end of the string would silently delete it.
 *
 * THE ERP KEEPS EVERY WORD. Nothing here writes to `variants.specials`, which is
 * priced BY NAME - renaming a special zeroes its surcharge on the next save
 * (`docs/bugs/0770-shortening-the-stored-text-to-fit-autocount-would-have-repri.md`).
 * This is a rendering decision at the moment of sending, like the abbreviations
 * above it.
 */
export function pointSpecialsAtTheErp(text: string): string {
  const segments = text.split(SEGMENT);
  let touched = false;
  const out = segments.map((seg) => {
    if (!/^\s*SPECIAL\s*:/i.test(seg)) return seg;
    touched = true;
    return SPECIAL_ORDER_POINTER;
  });
  return touched ? out.join(SEGMENT) : text;
}
