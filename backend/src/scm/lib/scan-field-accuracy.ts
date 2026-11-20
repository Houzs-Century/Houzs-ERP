// Field-level accuracy of one reviewed sales-slip scan for the OCR page
// (services/ocrStats.ts): how many of the slip's fields the AI read right.
// Compares the AI read (`extracted`) to what the person confirmed (`corrected`),
// the same pair changedFields compares.
import { HEADER_FIELDS, LINE_FIELDS, asObj, j } from "./scan-slip-fields";
import { BLANK, displayValue } from "./scan-correction-detail";
import { uniqueByRawText } from "./scan-sample-review";

export interface FieldScore {
  /** Fields with a value on the slip read or after the review. Blank on both sides is not counted. */
  total: number;
  /** Of those, the ones the person changed. */
  changed: number;
}

const hasValue = (key: string, v: unknown): boolean => displayValue(key, v) !== BLANK;
const asLines = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];

function filledFields(line: Record<string, unknown>): number {
  return LINE_FIELDS.filter(([key]) => hasValue(key, line[key])).length;
}

/**
 * Header fields score once per label (Address has two keys). Lines pair by a
 * unique slip text, then an identical unused line, then in order; a line with no
 * partner was missed (added by the person) or invented (removed), so each of its
 * filled fields counts as changed. Returns null without both sides.
 */
export function fieldScore(extracted: unknown, corrected: unknown): FieldScore | null {
  const ai = asObj(extracted);
  const op = asObj(corrected);
  if (!ai || !op) return null;
  let total = 0;
  let changed = 0;

  const labels = new Map<string, { filled: boolean; moved: boolean }>();
  for (const [key, label] of HEADER_FIELDS) {
    const cur = labels.get(label) ?? { filled: false, moved: false };
    cur.filled ||= hasValue(key, ai[key]) || hasValue(key, op[key]);
    cur.moved ||= j(ai[key]) !== j(op[key]);
    labels.set(label, cur);
  }
  for (const { filled, moved } of labels.values()) {
    if (!filled) continue;
    total++;
    if (moved) changed++;
  }

  const aiLines = asLines(ai.lines);
  const opLines = asLines(op.lines);
  const unused = new Set(aiLines);
  const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
  const leftover: Array<Record<string, unknown>> = [];
  for (const line of opLines) {
    const byText = uniqueByRawText(opLines, line.rawText) === null ? null : uniqueByRawText(aiLines, line.rawText);
    const partner = byText && unused.has(byText) ? byText : [...unused].find((a) => j(a) === j(line)) ?? null;
    if (!partner) {
      leftover.push(line);
      continue;
    }
    unused.delete(partner);
    pairs.push([partner, line]);
  }
  // Lines with no slip text to tie them pair in order; only the excess was missed or invented.
  for (const line of leftover) {
    const partner = unused.values().next().value;
    if (!partner) {
      const n = filledFields(line);
      total += n;
      changed += n;
      continue;
    }
    unused.delete(partner);
    pairs.push([partner, line]);
  }
  for (const [partner, line] of pairs) {
    for (const [key] of LINE_FIELDS) {
      if (!hasValue(key, partner[key]) && !hasValue(key, line[key])) continue;
      total++;
      if (j(partner[key]) !== j(line[key])) changed++;
    }
  }
  for (const line of unused) {
    const n = filledFields(line);
    total += n;
    changed += n;
  }
  return { total, changed };
}
