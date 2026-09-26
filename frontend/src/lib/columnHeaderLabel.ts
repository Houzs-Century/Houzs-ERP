/**
 * Column headers are shown in English Title Case ("Delivery Date"), system-wide
 * (owner 2026-09-25). Column definitions were written for an all-caps CSS
 * header, so their literals are a mix of "Delivery date", "Order total" and
 * "price_tier"; normalising at render time keeps ~1,000 literals untouched.
 *
 * A word that already carries a capital (PO, DO, QC, AutoCount, eBay) is kept
 * as written, so acronyms never become "Po".
 */
const MINOR_WORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "per", "the", "to", "vs", "via", "x",
]);
/** Units read wrong capitalised ("Rent / Sqm"). */
const UNITS = new Set(["sqm", "sqft", "kg", "g", "cm", "mm", "km", "pcs", "hrs", "mins"]);

export function headerLabel(label: string): string {
  const words = label.replace(/_/g, " ").split(" ");
  let seenWord = false;
  return words
    .map((word) => {
      const m = /^([^A-Za-z0-9]*)([A-Za-z0-9].*)$/.exec(word);
      if (!m) return word;
      const [, lead, rest] = m;
      const first = !seenWord;
      seenWord = true;
      if (/[A-Z]/.test(rest)) return word;
      if (!first && !lead && MINOR_WORDS.has(rest.toLowerCase())) return word;
      if (!first && UNITS.has(rest.replace(/[^a-z]/g, ""))) return word;
      return lead + rest.charAt(0).toUpperCase() + rest.slice(1);
    })
    .join(" ");
}
