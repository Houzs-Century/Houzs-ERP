// ---------------------------------------------------------------------------
// scan-word-match — which line a printed row most likely is, when its code and its
// name are spelled the supplier's way: "DUN CS2 PURE BREEZE MAT 190X152X30CM" is
// DL-CS2 PURE BREEZE (Q), "SF9050 - 1EPL + 1B" is AMN-SF9050 SOFA 1B(RHF).
//
// This only fills the check screen, where a person confirms each row (it arrives
// marked "matched by name, check"). No draft is ever made from it.
// ---------------------------------------------------------------------------

const NOISE = new Set(['SOFA', 'BEDFRAME', 'BED', 'DIVAN', 'MAT', 'MATT', 'MATTRESS', 'FABRIC', 'SIZE', 'COL', 'SEAT', 'LEG', 'THE', 'AND', 'WITH', 'PO', 'SO', 'NEW', 'BOX', 'UNIT', 'PCS', 'SET', 'FT', 'FTS', 'CM', 'KING', 'QUEEN', 'SINGLE', 'SUPER', 'LHF', 'RHF']);

// "DSL 8075" and DSL8075 are one word.
const wordsOf = (s: string | null | undefined): string[] =>
  (s ?? '').toUpperCase().replace(/\b([A-Z]{2,5})\s+(\d{3,})/g, '$1$2').split(/[^A-Z0-9]+/).filter((w) => w.length >= 2 && !NOISE.has(w) && !/^\d+$/.test(w));

/** A word that names one model, not a kind of thing: letters and digits, SF9050. */
const isModel = (w: string): boolean => w.length >= 4 && /[A-Z]/.test(w) && /\d/.test(w);

/** The bed size a row prints, as our codes spell it: 190X152, W152 X L190 or 5 FTS is (Q). */
export function printedSize(text: string | null | undefined): string | null {
  const t = (text ?? '').toUpperCase();
  // ERGOTEX prints W152 X L190.
  const cm = /(?<!\d)(?:190|200)\s*X\s*[WL]?(91|107|152|183|200)(?!\d)|(?<!\d)(91|107|152|183|200)\s*X\s*[WL]?(?:190|200)(?!\d)/.exec(t);
  const width = cm?.[1] ?? cm?.[2];
  if (width) return { 91: 'S', 107: 'SS', 152: 'Q', 183: 'K', 200: 'SK' }[width] ?? null;
  const ft = /\b(3\.5|3|5|6)\s*(?:FT|FTS|FEET)\b/.exec(t)?.[1];
  return ft ? ({ 3: 'S', 3.5: 'SS', 5: 'Q', 6: 'K' } as Record<string, string>)[ft] ?? null : null;
}

/** The model word of a supplier code: NB-KHJ50(K) and NB-KHJ57 (F) (Q) are KHJ50 and KHJ57. */
export function skuModelWord(sku: string | null | undefined): string | null {
  return wordsOf(sku).filter((w) => w !== 'NB').find(isModel) ?? null;
}

/** Our product family, the code without its size: HILTON (A)-(Q) is HILTON (A). */
export const familyOf = (itemCode: string): string => itemCode.replace(/\s*-?\s*\((S|SS|Q|K|SK)\)\s*$/i, '').trim().toUpperCase();

/** A supplier's model word -> our families, from every code bound to that supplier.
 *  One size's binding names the family for all its sizes. */
export function familiesByModelWord(bindings: ReadonlyArray<{ supplierSku: string | null; itemCode: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const b of bindings) {
    const word = skuModelWord(b.supplierSku);
    if (word) out.set(word, (out.get(word) ?? new Set()).add(familyOf(b.itemCode)));
  }
  return out;
}

/** The families a printed row names: SB10-B11EC-KHJ50(A)(MH-12") carries KHJ50. */
export function familiesPrinted(printed: string | null | undefined, known: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const out = new Set<string>();
  for (const w of wordsOf(printed)) for (const f of known.get(w) ?? []) out.add(f);
  return out;
}

export const lineSizeOf = (itemCode: string): string | null => /\((S|SS|Q|K|SK)\)\s*$/.exec(itemCode.toUpperCase())?.[1] ?? null;

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
