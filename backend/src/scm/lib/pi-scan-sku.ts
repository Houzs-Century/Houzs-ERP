// ---------------------------------------------------------------------------
// pi-scan-sku — which of our SKUs a printed invoice row is, when the supplier
// prints ITS code and not ours, and which open Goods Receipt line to propose for
// it. HOOKKA prints "1013-(Q)" for our JAGER-(Q) and "5540-1A(LHF)" for our
// 8030-1A(LHF). Pure; everything here only fills the check screen, where each row
// arrives marked for a person to confirm.
// ---------------------------------------------------------------------------

import { nameFits } from './grn-scan-check';
import { normalizeCode } from './pi-scan-match';
import { familyOf, lineSizeOf, printedSize } from './scan-word-match';

/** "CELENE (A)-(Q)" and "CELENE(A)-(Q)" are one code. */
export const squashCode = (s: string | null | undefined): string => normalizeCode(s).replace(/\s+/g, '');

const ALNUM = /[A-Z0-9]/;
// A shared tail starts a new part of the code: "-(Q)", "(A)-(K)", "-2A(RHF)".
const TAIL_START = /[-(/]/;

/** The bed size a printed code names, "(Q)" in "1013-(Q)". */
export const codeBedSize = (code: string | null | undefined): string | null =>
  /\((S|SS|Q|K|SK)\)/.exec(normalizeCode(code))?.[1] ?? null;

/** Supplier model prefix -> our model prefix, from every code pair known for the
 *  supplier: "1007-(K)" bound to CODY-(K) says 1007 is CODY, so "1007-(Q)" is
 *  CODY-(Q) though only the king was ever bound. */
export function modelPrefixes(known: ReadonlyArray<{ supplierSku: string | null; itemCode: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const k of known) {
    const a = squashCode(k.supplierSku);
    const b = squashCode(k.itemCode);
    if (!a || !b || a === b) continue;
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
    while (n > 0 && !TAIL_START.test(a[a.length - n]!)) n -= 1;
    if (n === 0) continue;
    const from = a.slice(0, a.length - n);
    const to = b.slice(0, b.length - n);
    if (!from || !to || from === to) continue;
    out.set(from, (out.get(from) ?? new Set()).add(to));
  }
  return out;
}

/** Our code for a printed one through a learned model prefix, when exactly one
 *  of `ours` is what it translates to. */
export function codeByPrefix(printed: string | null | undefined, prefixes: ReadonlyMap<string, ReadonlySet<string>>, ours: ReadonlyArray<string>): string | null {
  const p = squashCode(printed);
  if (!p) return null;
  const bySquash = new Map(ours.map((o) => [squashCode(o), o]));
  const fits = [...prefixes.keys()].filter((from) => p.startsWith(from) && (p.length === from.length || !ALNUM.test(p[from.length]!)));
  if (fits.length === 0) return null;
  const longest = Math.max(...fits.map((f) => f.length));
  const hits = new Set<string>();
  for (const from of fits.filter((f) => f.length === longest)) {
    for (const to of prefixes.get(from) ?? []) {
      const hit = bySquash.get(to + p.slice(from.length));
      if (hit) hits.add(hit);
    }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

const wordCount = (s: string): number => s.split(/[^A-Z0-9]+/).filter(Boolean).length;

/** Our code by the model name the row prints and the size its code or name
 *  carries: "1013-(Q)" "JAGER BEDFRAME (5FT) (152X190CM)" is JAGER-(Q). The most
 *  specific model wins (CELENE (A) over CELENE); two equally specific, none. */
export function codeByDescription(printedCode: string | null | undefined, description: string | null | undefined, ours: ReadonlyArray<string>): string | null {
  if (!description) return null;
  const size = codeBedSize(printedCode) ?? printedSize(description) ?? printedSize(printedCode);
  const fits = [...new Set(ours)].filter((o) => {
    const family = familyOf(o);
    // A model needs a real word: a bare "A" or "2" names nothing.
    if (!family.split(/[^A-Z0-9]+/).some((w) => w.length >= 3)) return false;
    return (lineSizeOf(o) ?? null) === size && nameFits(description, family);
  });
  if (fits.length === 0) return null;
  const top = Math.max(...fits.map((o) => wordCount(familyOf(o))));
  const best = fits.filter((o) => wordCount(familyOf(o)) === top);
  return best.length === 1 ? best[0]! : null;
}

/** Our code for a printed row: the code itself, a learned model prefix, then the
 *  model name it prints. */
export function skuOfRow(printedCode: string | null | undefined, description: string | null | undefined, prefixes: ReadonlyMap<string, ReadonlySet<string>>, ours: ReadonlyArray<string>): string | null {
  const p = squashCode(printedCode);
  const same = p ? ours.find((o) => squashCode(o) === p) : undefined;
  return same ?? codeByPrefix(printedCode, prefixes, ours) ?? codeByDescription(printedCode, description, ours);
}

/** An open receipt line the proposal can bill. */
export type ProposableLine = { grnItemId: string; grnNumber: string; itemCode: string; receivedAt: string | null };
export type SkuRow = { key: string; itemCode: string; qty: number };

/**
 * Which open receipt line each row bills, for an invoice no receipt is known to
 * be for: the receipt holding the most of the invoice's rows first, then the
 * oldest. Two receipts as good as each other (as many rows, received the same
 * day) never decide a row both could bill: it stays for the person to choose.
 * `left` is what each line still has to bill and is spent as rows take it.
 */
export function proposeGrnLines(rows: ReadonlyArray<SkuRow>, lines: ReadonlyArray<ProposableLine>, left: Map<string, number>): Map<string, string> {
  const out = new Map<string, string>();
  const day = (l: ProposableLine) => (l.receivedAt ?? '').slice(0, 10);
  const ageOf = new Map<string, string>();
  for (const l of lines) if (!ageOf.has(l.grnNumber) || day(l) < ageOf.get(l.grnNumber)!) ageOf.set(l.grnNumber, day(l));
  const lineFor = (r: SkuRow, grn: string): ProposableLine | undefined => {
    const on = lines.filter((l) => l.grnNumber === grn && l.itemCode === r.itemCode && (left.get(l.grnItemId) ?? 0) > 0);
    return on.find((l) => (left.get(l.grnItemId) ?? 0) >= r.qty) ?? on[0];
  };
  const take = (r: SkuRow, grn: string) => {
    const l = lineFor(r, grn);
    if (!l) return;
    out.set(r.key, l.grnItemId);
    left.set(l.grnItemId, (left.get(l.grnItemId) ?? 0) - r.qty);
  };
  let todo = [...rows];
  while (todo.length > 0) {
    const cover = new Map<string, SkuRow[]>();
    for (const r of todo) for (const grn of new Set(lines.filter((l) => l.itemCode === r.itemCode && (left.get(l.grnItemId) ?? 0) > 0).map((l) => l.grnNumber))) {
      cover.set(grn, [...(cover.get(grn) ?? []), r]);
    }
    if (cover.size === 0) break;
    const rank = [...cover].sort(([ga, ra], [gb, rb]) => rb.length - ra.length || (ageOf.get(ga) ?? '').localeCompare(ageOf.get(gb) ?? ''));
    const [bestGrn, bestRows] = rank[0]!;
    const ties = rank.filter(([g, rs]) => rs.length === bestRows.length && ageOf.get(g) === ageOf.get(bestGrn)).map(([g]) => g);
    if (ties.length === 1) {
      for (const r of bestRows) take(r, bestGrn);
      const done = new Set(bestRows.map((r) => r.key));
      todo = todo.filter((r) => !done.has(r.key));
      continue;
    }
    // Equally good receipts: a row only one of them holds is that one's; a row
    // two of them hold is nobody's to decide here.
    const done = new Set<string>();
    for (const r of todo) {
      const holders = ties.filter((g) => cover.get(g)?.includes(r));
      if (holders.length === 0) continue;
      if (holders.length === 1) take(r, holders[0]!);
      done.add(r.key);
    }
    todo = todo.filter((r) => !done.has(r.key));
  }
  return out;
}
