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
  /* Still over. Return the SHORTENED text rather than the original: it is the
     same specification in the owner's own words, and the caller's refusal
     message then reports the length that is actually the problem. */
  return out;
}
