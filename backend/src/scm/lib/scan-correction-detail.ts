// What a person changed on a scanned sales order, as before/after text for the OCR
// page (services/ocrStats.ts). "before" is the draft as the scan built it
// (so_scan_samples.draft_baseline), "after" is what the person confirmed.
import { HEADER_FIELDS, LINE_FIELDS, LINES_CHANGED, asObj, changedFields } from "./scan-slip-fields";
import { uniqueByRawText } from "./scan-sample-review";

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

const BLANK = "(blank)";

/** `+60123456789` and the bare `123456789` the draft keeps both read as `0123456789`. */
export function localPhone(raw: string): string {
  const t = raw.replace(/[\s-]+/g, "");
  if (t.startsWith("+60")) return `0${t.slice(3)}`;
  // shortcut: a bare 8-10 digit number is taken as a Malaysian number missing its 0.
  return /^[1-9]\d{7,9}$/.test(t) ? `0${t}` : t;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function one(key: string, v: unknown): string {
  if (typeof v === "number") {
    return key === "depositRm"
      ? `RM ${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : String(v);
  }
  const o = asObj(v);
  if (o) return text(o.value) || text(o.code);
  const t = text(v);
  return key === "phones" ? localPhone(t) : t;
}

/** A slip value as short display text. Option and code matches show their value or code. */
export function displayValue(key: string, v: unknown): string {
  const parts = (Array.isArray(v) ? v : [v]).map((x) => one(key, x)).filter((s) => s !== "");
  return parts.length ? parts.join(", ") : BLANK;
}

const asLines = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
const same = (a: string, b: string): boolean => a === b;
const NONE = "(none)";

function describeLine(line: Record<string, unknown>): string {
  const product = displayValue("skuMatch", line.skuMatch);
  const name = product === BLANK ? text(line.rawText) || BLANK : product;
  return `${name}, qty ${displayValue("qtyGuess", line.qtyGuess)}`;
}

function partnerLine(
  line: Record<string, unknown>,
  ownLines: Array<Record<string, unknown>>,
  otherLines: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  return uniqueByRawText(ownLines, line.rawText) === null ? null : uniqueByRawText(otherLines, line.rawText);
}

function lineCountChanges(
  baseLines: Array<Record<string, unknown>>,
  finLines: Array<Record<string, unknown>>,
): FieldChange[] {
  const removed = baseLines
    .filter((line) => partnerLine(line, baseLines, finLines) === null)
    .map((line) => ({ field: "Line removed", before: describeLine(line), after: NONE }));
  const added = finLines
    .filter((line) => partnerLine(line, finLines, baseLines) === null)
    .map((line) => ({ field: "Line added", before: NONE, after: describeLine(line) }));
  return [...removed, ...added];
}

/**
 * Per changed field, the draft's value and the confirmed value. Only fields
 * `changedFields(extracted, corrected)` names are listed, so the detail never
 * shows a change the field-miss counts do not. Lines pair by their raw slip text
 * (the same rule keepPersonChanges uses), never by position; a line that does not
 * pair is left out. When the line count changed, every line that does not pair
 * is listed as removed (draft only) or added (confirmed only). Returns null
 * without a baseline (scans from before it was kept).
 */
export function correctionChanges(extracted: unknown, corrected: unknown, baseline: unknown): FieldChange[] | null {
  const base = asObj(baseline);
  const fin = asObj(corrected);
  if (!base || !fin) return null;
  const names = new Set(changedFields(extracted, corrected));
  const out: FieldChange[] = [];
  const seen = new Set<string>();
  for (const [key, label] of HEADER_FIELDS) {
    if (!names.has(label) || seen.has(label)) continue;
    const before = displayValue(key, base[key]);
    const after = displayValue(key, fin[key]);
    if (same(before, after)) continue;
    seen.add(label);
    out.push({ field: label, before, after });
  }
  const baseLines = asLines(base.lines);
  const finLines = asLines(fin.lines).filter((l) => !(text(l.rawText) === "" && asObj(l.skuMatch)?.code == null));
  if (names.has(LINES_CHANGED)) out.push(...lineCountChanges(baseLines, finLines));
  finLines.forEach((line, i) => {
    const b = uniqueByRawText(baseLines, line.rawText);
    if (!b || uniqueByRawText(finLines, line.rawText) === null) return;
    for (const [key, label] of LINE_FIELDS) {
      if (!names.has(label)) continue;
      const before = displayValue(key, b[key]);
      const after = displayValue(key, line[key]);
      if (!same(before, after)) out.push({ field: `Line ${i + 1} ${label}`, before, after });
    }
  });
  return out;
}
