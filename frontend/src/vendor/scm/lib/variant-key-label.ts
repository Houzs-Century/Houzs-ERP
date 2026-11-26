
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
