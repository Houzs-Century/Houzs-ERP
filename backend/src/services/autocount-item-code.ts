// ----------------------------------------------------------------------------
// autocount-item-code — divergence D10.
//
// THE PROBLEM. The ERP's material_code is NOT AutoCount's ItemCode. "9028-1S"
// is an ERP code; the account book calls the same sofa "AMN-SF9028 SOFA". Until
// now the write-back composed details with identityResolver and sent the ERP
// code straight through, so a create would have written line after line of item
// codes the licensed book has never heard of.
//
// THE MAP. backend/scripts/data/autocount-erp-mapping-1561.csv is the record of
// the cutover: every AutoCount item, and the ERP code it was opened as. It is
// compiled into autocount-item-map.ts (generated, CI-checked) because a Worker
// cannot read a CSV. Verified against the live AED_HOUZS Item table on
// 2026-08-11: 1561 rows on both sides, zero codes missing in either direction.
//
// THE MAP IS NOT INVERTIBLE ON ITS OWN. The cutover collapsed supplier-specific
// AutoCount codes onto one ERP code — "DIVAN ONLY-(K)" came from four different
// AutoCount items, "9028-1S" from two. The CSV's own supplier column is the
// disambiguator, and a purchase order knows its creditor, so the PO side
// resolves. A sales order line names no supplier, so some of them cannot be
// resolved from the line alone.
//
// WHAT THIS MODULE DOES ABOUT THAT: it REFUSES. Every line resolves to exactly
// one AutoCount ItemCode or is reported with a named reason and the candidates
// it could not choose between. There is NO fallback to material_code — that
// fallback is what would put a nonexistent item into a licensed account book,
// and on a purchase order the resulting line cannot be deleted.
// ----------------------------------------------------------------------------
import { AC_ITEM_MAP_TSV, AC_ITEM_MAP_ROWS } from './autocount-item-map';
import { splitSofaCode } from './autocount-sofa-collapse';
import { SOFA_MODEL_ALIAS } from '../../scripts/lib/parse-sofa.mjs';

export interface AcItemMapEntry {
  /** The AutoCount ItemCode. */
  ac: string;
  /** The ERP material_code it was opened as. */
  erp: string;
  category: string;
  /** AutoCount creditor code, which is also scm.suppliers.code. */
  supplier: string | null;
}

export interface AcItemIndex {
  byErp: Map<string, AcItemMapEntry[]>;
  rows: number;
}

const up = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();

export function buildAcItemIndex(tsv: string = AC_ITEM_MAP_TSV): AcItemIndex {
  const byErp = new Map<string, AcItemMapEntry[]>();
  let rows = 0;
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const [ac, erp, category, supplier] = line.split('\t');
    if (!ac || !erp) continue;
    rows += 1;
    const entry: AcItemMapEntry = { ac, erp, category: category ?? '', supplier: supplier || null };
    const k = up(erp);
    const bucket = byErp.get(k);
    if (bucket) bucket.push(entry); else byErp.set(k, [entry]);
  }
  return { byErp, rows };
}

let cached: AcItemIndex | null = null;
export function acItemIndex(): AcItemIndex {
  if (!cached) cached = buildAcItemIndex();
  return cached;
}

/** The ERP models that an AutoCount model was folded onto at the cutover. */
const ALIAS_SOURCES: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [from, to] of Object.entries(SOFA_MODEL_ALIAS as Record<string, string>)) {
    const k = up(to);
    const bucket = m.get(k);
    if (bucket) bucket.push(from); else m.set(k, [from]);
  }
  return m;
})();

export type ItemCodeResolution =
  | { ok: true; acItemCode: string; via: 'direct' | 'sofa-model' }
  | { ok: false; reason: 'unmapped' | 'ambiguous'; detail: string; candidates: string[] };

/**
 * Resolve one ERP item code to exactly one AutoCount ItemCode.
 *
 * `supplierCode` is the document's creditor (scm.suppliers.code). Pass it when
 * the document has one — it is what separates the codes the cutover collapsed.
 * A sales order has none, and the honest consequence is that a handful of its
 * lines are refused rather than guessed at.
 */
export function resolveAcItemCode(
  erpItemCode: string,
  opts: { supplierCode?: string | null; index?: AcItemIndex } = {},
): ItemCodeResolution {
  const index = opts.index ?? acItemIndex();
  const code = up(erpItemCode);
  if (!code) return { ok: false, reason: 'unmapped', detail: 'the ERP line has no item code', candidates: [] };

  let candidates = index.byErp.get(code) ?? [];
  let via: 'direct' | 'sofa-model' = 'direct';

  /* A sofa compartment has no AutoCount item of its own — the whole point of
     D9 is that AutoCount holds ONE line for the build. So the compartment
     resolves through the model's base SKU, plus every AutoCount model the
     cutover folded onto this ERP model (SOFA_MODEL_ALIAS). Including the alias
     sources is what makes the answer honest: ERP model 8030 really does stand
     for three different AutoCount items, and pretending otherwise would pick
     one of them at random. */
  if (!candidates.length) {
    const split = splitSofaCode(erpItemCode);
    if (split) {
      via = 'sofa-model';
      const models = [split.model, ...(ALIAS_SOURCES.get(up(split.model)) ?? [])];
      const seen = new Set<string>();
      const acc: AcItemMapEntry[] = [];
      for (const m of models) {
        for (const e of index.byErp.get(up(`${m}-1S`)) ?? []) {
          if (seen.has(e.ac)) continue;
          seen.add(e.ac);
          acc.push(e);
        }
      }
      candidates = acc;
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      reason: 'unmapped',
      detail: `ERP item code '${erpItemCode}' is in no AutoCount cutover mapping row`,
      candidates: [],
    };
  }
  if (candidates.length === 1) return { ok: true, acItemCode: candidates[0].ac, via };

  const sup = up(opts.supplierCode);
  if (sup) {
    const narrowed = candidates.filter((e) => up(e.supplier) === sup);
    if (narrowed.length === 1) return { ok: true, acItemCode: narrowed[0].ac, via };
    if (narrowed.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        detail: `ERP item code '${erpItemCode}' maps to ${narrowed.length} AutoCount items even `
          + `for supplier ${opts.supplierCode}`,
        candidates: narrowed.map((e) => e.ac),
      };
    }
    return {
      ok: false,
      reason: 'ambiguous',
      detail: `ERP item code '${erpItemCode}' maps to ${candidates.length} AutoCount items and none `
        + `belongs to supplier ${opts.supplierCode}`,
      candidates: candidates.map((e) => e.ac),
    };
  }

  return {
    ok: false,
    reason: 'ambiguous',
    detail: `ERP item code '${erpItemCode}' maps to ${candidates.length} AutoCount items and the `
      + 'document names no supplier to choose between them',
    candidates: candidates.map((e) => e.ac),
  };
}

/**
 * Thrown when a document cannot be composed because at least one line has no
 * single AutoCount ItemCode. Carries every failing line, because an operator
 * fixing one and re-saving only to hit the next is how a divergence outlives
 * everyone who remembers it.
 */
export class ItemCodeError extends Error {
  readonly failures: ReadonlyArray<{ index: number; erpItemCode: string; detail: string }>;
  constructor(failures: Array<{ index: number; erpItemCode: string; detail: string }>) {
    super(
      `${failures.length} line(s) have no single AutoCount ItemCode: `
      + failures.map((f) => `line ${f.index + 1} — ${f.detail}`).join('; '),
    );
    this.name = 'ItemCodeError';
    this.failures = failures;
  }
}

export { AC_ITEM_MAP_ROWS };
