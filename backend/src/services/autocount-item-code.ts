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
  /** Every ItemCode the account book held at the cutover, uppercased. */
  acCodes: Set<string>;
  rows: number;
}

const up = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();

export function buildAcItemIndex(tsv: string = AC_ITEM_MAP_TSV): AcItemIndex {
  const byErp = new Map<string, AcItemMapEntry[]>();
  const acCodes = new Set<string>();
  let rows = 0;
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const [ac, erp, category, supplier] = line.split('\t');
    if (!ac || !erp) continue;
    rows += 1;
    const entry: AcItemMapEntry = { ac, erp, category: category ?? '', supplier: supplier || null };
    acCodes.add(up(ac));
    const k = up(erp);
    const bucket = byErp.get(k);
    if (bucket) bucket.push(entry); else byErp.set(k, [entry]);
  }
  return { byErp, acCodes, rows };
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
  | { ok: true; acItemCode: string; via: 'direct' | 'sofa-model' | 'binding' | 'default-choice' }
  | { ok: false; reason: 'unmapped' | 'ambiguous'; detail: string; candidates: string[] };

/**
 * Resolve one ERP item code to exactly one AutoCount ItemCode.
 *
 * `supplierCode` is the document's creditor (scm.suppliers.code). Pass it when
 * the document has one — it is what separates the codes the cutover collapsed.
 * A sales order has none, and the honest consequence is that a handful of its
 * lines are refused rather than guessed at.
 */
/**
 * AutoCount items the ERP OPENS ITSELF, rather than ones the cutover found.
 *
 * `/ensure-masters` creates an item before the document that names it is sent
 * (AcSyncService.cs:495-521) — ItemGroup OTHER, StockControl, sales + purchase,
 * base UOM UNIT — and skips one that already exists. So a code the account book
 * has never held is not a dead end; it is opened on first use.
 *
 * That cuts both ways, which is why this set exists as an explicit, reviewed
 * list instead of "anything goes". A typo does not fail — it silently OPENS a
 * junk item in a licensed account book, and the ERP would keep posting to it.
 * Nothing reaches /ensure-masters as a new item unless it is named here.
 */
export const AC_ITEMS_ERP_OPENS: ReadonlySet<string> = new Set([
  /* One canonical item per sofa model, named EXACTLY as the ERP names it, so
     the two systems agree character for character and the stock reconciliation
     needs no translation. The cutover had collapsed each of these onto two
     brand items (Armani/DorsettLoft, RedSofa/THL, two Todern spellings), which
     a sales order can never choose between — it does not know the brand until
     purchasing does. The brand now lives on the purchase order, where it is
     actually known, and the item is one. */
  '9028-1S',
  '9058-1S',
  '5152-1S',
  '5080-1S',
]);

/**
 * THE STANDING CHOICE for an ERP code the cutover left pointing at several
 * AutoCount items, used when the document has no creditor to choose with.
 *
 * A purchase order names its supplier and resolves on its own. A SALES ORDER
 * never does, so before this every order containing one of these was refused —
 * correctly, but permanently, because nothing downstream could supply the
 * missing fact either. The supplier SKU binding cannot stand in for it: that
 * column means "what this supplier calls it" and is printed on documents sent
 * to the supplier, so writing an AutoCount code into it to satisfy the sync
 * would corrupt purchasing. This is the separate, deliberate answer.
 *
 * Owner's rule, 2026-08-13: "一个 item 统一一个" — one ERP item, one AutoCount
 * item, and here that is the ERP's own code, opened by /ensure-masters.
 *
 * The old brand items keep every line they already hold: composeEdit omits
 * ItemCode for a line AutoCount already owns, so an edit to a pre-cutover order
 * never rewrites its item to this one.
 */
export const AC_DEFAULT_ITEM_CHOICE: ReadonlyMap<string, string> = new Map([
  ['9028-1S', '9028-1S'],
  ['9058-1S', '9058-1S'],
  ['5152-1S', '5152-1S'],
  ['5080-1S', '5080-1S'],
]);

/**
 * The choice for `code`, once it is safe to use.
 *
 * Either it names one of the items the book already holds for this code, or it
 * is a code we have declared the ERP opens. Anything else is a typo and is
 * treated as no choice at all.
 */
function defaultChoiceFor(code: string, candidates: AcItemMapEntry[]): string | null {
  /* Keyed by the model base code, because that is what D9 hands the resolver.
     A raw compartment reaching here (a caller resolving one line at a time)
     means the same sofa and must get the same answer — otherwise the choice
     silently depends on which side of the collapse the caller sits. */
  const split = splitSofaCode(code);
  const want = AC_DEFAULT_ITEM_CHOICE.get(code)
    ?? (split ? AC_DEFAULT_ITEM_CHOICE.get(up(`${split.model}-1S`)) : undefined);
  if (!want) return null;
  const hit = candidates.find((e) => up(e.ac) === up(want));
  if (hit) return hit.ac;
  return AC_ITEMS_ERP_OPENS.has(want) ? want : null;
}

export function resolveAcItemCode(
  erpItemCode: string,
  opts: {
    supplierCode?: string | null;
    index?: AcItemIndex;
    /**
     * THE LIVE BINDING, and it wins.
     *
     * `scm.supplier_material_bindings` is where this ERP records what AutoCount
     * calls each of its products: `material_code` is our internal code,
     * `supplier_sku` is the AutoCount one, one row per supplier. It was
     * populated at the cutover for exactly this purpose — so the ERP codes
     * could be pushed BACK — and it is the only one of the two sources that
     * GROWS. The compiled CSV is a snapshot of the book on 2026-08-05 and can
     * never know a SKU opened since.
     *
     * Without this the resolver refused every post-cutover product, which
     * refused the whole document, which meant /ensure-masters never even ran
     * for the case it exists for. Keyed by UPPERCASED ERP code.
     */
    bindings?: Map<string, string> | null;
  } = {},
): ItemCodeResolution {
  const index = opts.index ?? acItemIndex();
  const code = up(erpItemCode);
  if (!code) return { ok: false, reason: 'unmapped', detail: 'the ERP line has no item code', candidates: [] };

  const bound = opts.bindings?.get(code);
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

  /* A TIE-BREAKER MUST NAME ONE OF THE TIED ITEMS.
   *
   * The binding normally WINS outright, and that is deliberate: the book can be
   * renamed and a 2026-08-05 snapshot cannot know, so an unrecognised SKU is
   * trusted. That reasoning holds while the map gives at most one answer.
   *
   * It does not hold when the code is AMBIGUOUS. There the binding is not an
   * override, it is a tie-breaker among items the book is known to hold — and a
   * tie-breaker naming a third string has not broken the tie, it has invented an
   * item. A rename cannot explain it either: if one candidate had been renamed
   * the binding would name the new name, and the OTHER candidate would still be
   * sitting there in the map. So this is wrong data, and sending it writes an
   * ItemCode the licensed book does not have — the exact outcome the "no
   * fallback to material_code" rule at the top of this file exists to prevent.
   * On a purchase order the resulting line cannot even be deleted.
   *
   * Measured against production on 2026-08-13, this is not hypothetical. All
   * four ambiguous sofa models carried bindings and not one named a real item:
   * the MAIN supplier's row for 9028-1S held the ERP's own code '9028-1S', and
   * the rest held 'AMN-SF9028 SOFA 1S' where the book has 'AMN-SF9028 SOFA'.
   * These refused already, because the binding was unreachable for a collapsed
   * sofa line; making it reachable without this guard would have turned four
   * loud refusals into phantom items opened in a licensed account book.
   *
   * Checked AFTER the sofa fallback so the refusal names what the book really
   * holds, which is the whole remedy an operator needs.
   */
  if (bound) {
    if (candidates.length <= 1 || index.acCodes.has(up(bound))) {
      return { ok: true, acItemCode: bound, via: 'binding' };
    }
    /* A bad binding does not get to refuse a code that HAS a standing choice —
       it is exactly the wrong data the choice was written to route around. Fall
       through to the normal path rather than returning the choice here, so a
       purchase order still narrows by its own creditor first and only a
       supplier-less document lands on the default. */
    if (!defaultChoiceFor(code, candidates)) return {
      ok: false,
      reason: 'ambiguous',
      detail: `ERP item code '${erpItemCode}' is bound to '${bound}', which is not an AutoCount `
        + `item. The account book holds this code as ${candidates.map((e) => `'${e.ac}'`).join(' or ')}`
        + ' — correct the supplier SKU mapping to name one of those exactly.',
      candidates: candidates.map((e) => e.ac),
    };
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

  /* NO SUPPLIER TO ASK, SO USE THE STANDING CHOICE — see AC_DEFAULT_ITEM_CHOICE.
     Last, so a purchase order's own creditor always wins over it. */
  const chosen = defaultChoiceFor(code, candidates);
  if (chosen) return { ok: true, acItemCode: chosen, via: 'default-choice' };

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
