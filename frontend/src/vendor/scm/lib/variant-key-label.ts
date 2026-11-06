/* ONE humanisation of a stored `variant_key`, in one place.
 *
 * A variant_key is the stored bucket identity — `fabriccode=bf-16|gap=16|
 * legheight=2` — and it is what actually moved when a transfer names a sofa in
 * one fabric rather than another. It reaches a person in two places now: the
 * Stock Transfer picker, which has humanised it since 2026-07-20, and the Stock
 * Transfer / Stock Take PDFs, which are new. Rather than let the second copy be
 * born (a hand-copied display rule is the drift class CLAUDE.md keeps paying
 * for — see `warehouse-label.ts`, where nine call sites disagreed), it lives
 * here and both read it.
 *
 * '' is a REAL value, not a missing one: it is the unclassified / plain-SKU
 * bucket, which is what an un-attributed item stores.
 */

/** `fabriccode=bf-16|gap=16` → `fabriccode bf-16 · gap 16`. '' → the label for
 *  the unclassified bucket, which callers pass because the two surfaces word it
 *  differently (a picker option vs. a printed cell). */
export const variantKeyLabel = (
  key: string | null | undefined,
  emptyLabel: string,
): string => {
  const k = (key ?? '').trim();
  if (!k) return emptyLabel;
  return k.split('|').map((s) => s.replace('=', ' ')).join(' · ');
};

/* The variant as a counting sheet prints it: the same facts, short words, so a
   bedframe row stays one or two lines instead of four. "fabriccode pc151-01 ·
   divanheight 10\"" → "pc151-01 · divan 10\"". */
const PRINT_KEY: Record<string, string> = {
  fabriccode: '', special: '', divanheight: 'divan', legheight: 'leg',
  totalheight: 'total', seatheight: 'seat', seatsize: 'seat',
};
export const printVariant = (label: string): string =>
  label.split(' · ').map((part) => {
    const sp = part.indexOf(' ');
    if (sp < 0) return part;
    const key = part.slice(0, sp).toLowerCase();
    if (!(key in PRINT_KEY)) return part;
    const short = PRINT_KEY[key];
    return short ? `${short} ${part.slice(sp + 1)}` : part.slice(sp + 1);
  }).join(' · ');

/** A stored key in the words a person reads: `fabriccode=bf-17|divanheight=8"` →
 *  `bf-17 · divan 8"`. */
export const variantWords = (key: string | null | undefined): string => printVariant(variantKeyLabel(key, ''));
