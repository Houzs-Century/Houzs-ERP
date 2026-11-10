// Nightly integrity check — the rules. Pure, so the unit suite holds them still.
//
// The judgement of "is this a mismatch" is NOT here: it is the shared core in
// scripts/lib/half-done-documents.mjs, which the on-demand 180-day audit
// (scripts/check-half-done-documents.mjs) uses too. This file only decides what
// the NIGHTLY pass counts on top of that:
//   - NEW only: activity in the last two days, so old cutover leftovers do not
//     alarm every night;
//   - known non-problems skipped: non-stock (service) item codes, company-1
//     spec-bucket differences on hard-bound items, PO lines from the cutover.
// The I/O is in nightlyIntegrityRun.ts. Nothing here reads or returns money.

import { isServiceLine } from "../scm/shared/service-sku";
import { HARD_BOUND_COMPANY_ID, isHardBoundLine } from "../scm/lib/so-stock-allocation";
import { lotBucketDiffs, type LotBucketRow } from "../../scripts/lib/half-done-documents.mjs";

export const NIGHTLY_WINDOW_DAYS = 2;
const DAY_MS = 86_400_000;

/** End of the 2026-08-28 AutoCount cutover day (Malaysia time). A PO line
 *  created before this was imported with AutoCount's received qty, which no ERP
 *  GRN line stands behind; comparing it with GRN lines is always "wrong". */
export const PO_CUTOVER_END_MS = Date.parse("2026-08-29T00:00:00+08:00");

type When = string | number | Date | null | undefined;
const ms = (v: When): number | null => {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

export function nightlyCutoffMs(nowMs: number): number {
  return nowMs - NIGHTLY_WINDOW_DAYS * DAY_MS;
}

/** A finding is new when its document saw activity at or after the cutoff. */
export function isNewFinding(activityAt: When, cutoffMs: number): boolean {
  const t = ms(activityAt);
  return t != null && t >= cutoffMs;
}

/** A non-stock line: the product master says category SERVICE (bare codes like
 *  DISPOSE, TRANSPORTATION CHARGES, STORAGE carry only that), or the line's own
 *  item_group / SVC- code says service. Same predicate the write path uses, so
 *  "the app writes no stock for it" and "the check expects none" agree. */
export function isNonStockCode(itemCode: string, itemGroup: string | null, nonStockCodes: ReadonlySet<string>): boolean {
  const code = itemCode.trim();
  return nonStockCodes.has(code) || isServiceLine({ itemCode: code, itemGroup, category: null });
}

/** Drop non-stock lines and every movement of a non-stock code, before the
 *  shared comparison sees them (a movement for a dropped code would otherwise
 *  read as an "extra"). */
export function withoutNonStock<L extends { itemCode: string; itemGroup?: string | null }, M extends { itemCode: string }>(
  lines: L[],
  movements: M[],
  nonStockCodes: ReadonlySet<string>,
): { lines: L[]; movements: M[] } {
  const dropped = new Set(nonStockCodes);
  const kept: L[] = [];
  for (const l of lines) {
    if (isNonStockCode(l.itemCode, l.itemGroup ?? null, nonStockCodes)) dropped.add(String(l.itemCode).trim());
    else kept.push(l);
  }
  return {
    lines: kept,
    movements: movements.filter((m) => !dropped.has(String(m.itemCode).trim()) && !isNonStockCode(m.itemCode, null, nonStockCodes)),
  };
}

/** PO lines imported at the cutover carry AutoCount's received qty. */
export function isCutoverPoLine(createdAt: When): boolean {
  const t = ms(createdAt);
  return t != null && t < PO_CUTOVER_END_MS;
}

export interface NightlyLotRow extends LotBucketRow {
  category: string | null;
  firstAt: When;
}

/**
 * Open FIFO lots vs movements, NEW buckets only (first movement or lot in the
 * window — an older bucket's difference is a leftover, not tonight's problem).
 * For the hard-bound company, a hard-bound item's variant buckets are added
 * together first: that company binds each sales line to its own PO, so which
 * spec bucket the stock sits in is not a problem there, only the item total.
 */
export function newLotBucketFindings(
  companyId: number,
  rows: NightlyLotRow[],
  cutoffMs: number,
  nonStockCodes: ReadonlySet<string>,
) {
  const merged = new Map<string, NightlyLotRow>();
  const out: NightlyLotRow[] = [];
  for (const r of rows) {
    if (isNonStockCode(r.itemCode, null, nonStockCodes)) continue;
    const bound = companyId === HARD_BOUND_COMPANY_ID && isHardBoundLine((r.category ?? "").toLowerCase(), r.itemCode);
    if (!bound) { out.push(r); continue; }
    const k = `${r.itemCode}|${r.warehouse}`;
    const m = merged.get(k);
    if (!m) { merged.set(k, { ...r, variantKey: "*", movementNet: Number(r.movementNet), lotOpen: Number(r.lotOpen) }); continue; }
    m.movementNet = Number(m.movementNet) + Number(r.movementNet);
    m.lotOpen = Number(m.lotOpen) + Number(r.lotOpen);
    const a = ms(m.firstAt), b = ms(r.firstAt);
    if (b != null && (a == null || b < a)) m.firstAt = r.firstAt;
    const la = ms(m.lastAt), lb = ms(r.lastAt);
    if (lb != null && (la == null || lb > la)) m.lastAt = r.lastAt;
  }
  return lotBucketDiffs([...out, ...merged.values()]).filter((r) => isNewFinding(r.firstAt, cutoffMs));
}

/** Labels for the classes the nightly pass runs. Class 6 is the bucket check. */
export const CLASS_LABEL = {
  grn_in_missing: "GRN posted, stock IN missing or wrong",
  do_out_missing: "DO shipped, stock OUT missing or wrong",
  do_cancel_not_reversed: "DO cancelled, stock OUT not reversed",
  po_received_mismatch: "PO received qty disagrees with GRN lines",
  rebank_no_entry: "Receipt moved bank, no new entry",
  lots_vs_movements: "New stock bucket: open lots disagree with movements",
  double_submit: "Same document submitted twice within 10 s",
} as const;
export type IntegrityClass = keyof typeof CLASS_LABEL;

export interface ClassResult {
  cls: IntegrityClass;
  count: number;
  /** Document numbers / item codes only — never an amount. */
  examples: string[];
  error: string | null;
}

export function totalFindings(results: ClassResult[]): number {
  return results.reduce((n, r) => n + r.count, 0);
}

/** One log line per company: counts per class, no document data. */
export function logLine(companyId: number, results: ClassResult[]): string {
  return `company ${companyId}: ` + results.map((r) => `${r.cls}=${r.error ? "ERROR" : r.count}`).join(" ");
}

/** The admin notice for one company's new findings, or null when there are none. */
export function integrityNotice(companyLabel: string, dateMyt: string, results: ClassResult[]): { title: string; body: string } | null {
  const total = totalFindings(results);
  if (total === 0) return null;
  const lines = results
    .filter((r) => r.count > 0)
    .map((r) => {
      const more = r.count > r.examples.length ? ` (+${r.count - r.examples.length} more)` : "";
      return `${CLASS_LABEL[r.cls]}: ${r.count} — ${r.examples.join("; ")}${more}`;
    });
  return {
    title: `Data check ${dateMyt}: ${total} new problem${total === 1 ? "" : "s"} in ${companyLabel}`,
    body:
      `Tonight's check found documents from the last ${NIGHTLY_WINDOW_DAYS} days whose stock, PO or bank did not follow. ` +
      `Please look at each one.\n` + lines.join("\n"),
  };
}
