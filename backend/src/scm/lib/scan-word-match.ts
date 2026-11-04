// ---------------------------------------------------------------------------
// scan-word-match — which line a printed row most likely is, when its code and its
// name are spelled the supplier's way: "DUN CS2 PURE BREEZE MAT 190X152X30CM" is
// DL-CS2 PURE BREEZE (Q), "SF9050 - 1EPL + 1B" is AMN-SF9050 SOFA 1B(RHF).
//
// This only fills the check screen, where a person confirms each row (it arrives
// marked "matched by name, check"). No draft is ever made from it.
// ---------------------------------------------------------------------------

const NOISE = new Set(['SOFA', 'BEDFRAME', 'BED', 'DIVAN', 'MAT', 'MATT', 'MATTRESS', 'FABRIC', 'SIZE', 'COL', 'SEAT', 'LEG', 'THE', 'AND', 'WITH', 'PO', 'SO', 'NEW', 'BOX', 'UNIT', 'PCS', 'SET', 'FT', 'FTS', 'CM', 'KING', 'QUEEN', 'SINGLE', 'SUPER', 'LHF', 'RHF']);

const wordsOf = (s: string | null | undefined): string[] =>
  (s ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 2 && !NOISE.has(w) && !/^\d+$/.test(w));

/** A word that names one model, not a kind of thing: letters and digits, SF9050. */
const isModel = (w: string): boolean => w.length >= 4 && /[A-Z]/.test(w) && /\d/.test(w);

/** The bed size a row prints, as our codes spell it: 190X152 or 5 FTS is (Q). */
export function printedSize(text: string | null | undefined): string | null {
  const t = (text ?? '').toUpperCase();
  const cm = /(?<!\d)(?:190|200)\s*X\s*(91|107|152|183|200)(?!\d)|(?<!\d)(91|107|152|183|200)\s*X\s*(?:190|200)(?!\d)/.exec(t);
  const width = cm?.[1] ?? cm?.[2];
  if (width) return { 91: 'S', 107: 'SS', 152: 'Q', 183: 'K', 200: 'SK' }[width] ?? null;
  const ft = /\b(3\.5|3|5|6)\s*(?:FT|FTS|FEET)\b/.exec(t)?.[1];
  return ft ? ({ 3: 'S', 3.5: 'SS', 5: 'Q', 6: 'K' } as Record<string, string>)[ft] ?? null : null;
}

const lineSize = (text: string): string | null => /\((S|SS|Q|K|SK)\)/.exec(text.toUpperCase())?.[1] ?? null;

/** The lines that share the most with the row: a model word, or two other words. */
export function bestLines<T>(printed: string | null | undefined, lines: readonly T[], textOf: (line: T) => string): T[] {
  const row = new Set(wordsOf(printed));
  if (row.size === 0) return [];
  const size = printedSize(printed);
  const scored = lines.flatMap((line) => {
    const text = textOf(line);
    const own = lineSize(text);
    if (size && own && size !== own) return [];
    const shared = [...new Set(wordsOf(text))].filter((w) => row.has(w));
    const score = shared.reduce((a, w) => a + (isModel(w) ? 2 : 1), 0);
    return score >= 2 ? [{ line, score }] : [];
  });
  const top = Math.max(0, ...scored.map((s) => s.score));
  return scored.filter((s) => s.score === top).map((s) => s.line);
}
