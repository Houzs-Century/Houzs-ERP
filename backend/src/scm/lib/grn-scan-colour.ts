// ---------------------------------------------------------------------------
// grn-scan-colour — the colour / fabric printed on a delivery-order row must
// agree with the PO line it is tied to. HOOKKA DO-2611-035 (owner 2026-11-10):
// HC-PO-2609-235 holds HOK-SQUARE PILLOW twice, fabric COVE-13 (owed 2) and
// COVE-09 (owed 3); the code alone cannot tell them apart, and paper COVE-09
// rows were tied to the COVE-13 line. The colour lives only in the PO line's
// variants (fabricCode), so it is carried on the open line as `colours`.
// ---------------------------------------------------------------------------

import { fabricCodeOf } from './fabric-supplier-code';
import { liveColour } from '../shared/variant-summary';

/** The colour codes a PO line's variants carry (our code, and the supplier's own
 *  code for it when stamped), as written. */
export function lineColours(variants: unknown): string[] {
  let v = variants;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!v || typeof v !== 'object') return [];
  const rec = v as Record<string, unknown>;
  const supplier = typeof rec.fabricSupplierCode === 'string' ? rec.fabricSupplierCode.trim() : '';
  const out = [fabricCodeOf(rec), supplier].map(liveColour).filter(Boolean);
  return [...new Set(out)];
}

/* Word tokens split at letter/digit boundaries, leading zeros dropped, so
   "COVE-09", "cove 9" and "COVE-009" read as one colour. */
const tokens = (s: string | null | undefined): string[] => (s ?? '').toUpperCase()
  .replace(/([A-Z])(?=\d)|(\d)(?=[A-Z])/g, '$1$2 ')
  .split(/[^A-Z0-9]+/)
  .filter(Boolean)
  .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));

const isNum = (t: string | undefined): boolean => t !== undefined && /^\d+$/.test(t);
const keyOf = (s: string): string => tokens(s).join(' ');

/**
 * The colours a row prints, among those the `known` lines carry: a known colour
 * printed whole, or another number of the same series (a COVE-13 line makes a
 * printed COVE-11 a colour too). A colour with no letter is never looked for:
 * a bare number on the row is a size or a model.
 */
export function printedColours(printed: string | null | undefined, known: ReadonlyArray<{ colours?: string[] | null }>): Set<string> {
  const row = tokens(printed);
  const out = new Set<string>();
  if (row.length === 0) return out;
  const at = (seq: string[], i: number): boolean => seq.every((t, k) => row[i + k] === t);
  for (const c of new Set(known.flatMap((l) => l.colours ?? []))) {
    const kt = tokens(c);
    if (kt.length === 0 || !kt.some((t) => /[A-Z]/.test(t))) continue;
    for (let i = 0; i < row.length; i += 1) if (at(kt, i)) out.add(kt.join(' '));
    const series = kt.length >= 2 && isNum(kt[kt.length - 1]) ? kt.slice(0, -1) : null;
    if (!series || !series.some((t) => /[A-Z]/.test(t))) continue;
    for (let i = 0; i + series.length < row.length; i += 1) {
      if (at(series, i) && isNum(row[i + series.length])) out.add([...series, row[i + series.length]].join(' '));
    }
  }
  return out;
}

/**
 * The candidate lines whose colour agrees with the row. When the row prints no
 * colour of the `known` lines, all of them (today's behaviour). Otherwise a
 * line with a colour that is not printed is dropped; a line with no colour is
 * kept, it cannot disagree.
 */
export function byPrintedColour<T extends { colours?: string[] | null }>(printed: string | null | undefined, candidates: T[], known: ReadonlyArray<{ colours?: string[] | null }> = candidates): T[] {
  const p = printedColours(printed, [...known, ...candidates]);
  if (p.size === 0) return candidates;
  return candidates.filter((l) => !(l.colours ?? []).length || (l.colours ?? []).some((c) => p.has(keyOf(c))));
}
