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
  | { ok: true; acItemCode: string; via: 'direct' | 'sofa-model' | 'binding'
      | 'same-name' | 'preferred-supplier' | 'erp-canonical' }
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
 * WHO WINS when the cutover left one ERP code pointing at several AutoCount
 * items and the document cannot say which.
 *
 * Owner's rule, 2026-08-13: prefer HOK, then NB. Both are AutoCount ItemCode
 * prefixes (HOK- is creditor 400-O002, NB- is 400-N002). This is what clears
 * the bulk of it — of the 117 ambiguous ERP codes in the map, 102 are BEDFRAME,
 * and HOK alone settles 103 of the 117.
 */
const SUPPLIER_PREFERENCE = ['HOK', 'NB'] as const;

/**
 * THE LAST WORD: our own code, opened in AutoCount if the book has never held
 * it.
 *
 * `/ensure-masters` creates an item before the document that names it is sent
 * (AcSyncService.cs:495-521 — ItemGroup OTHER, StockControl, sales + purchase,
 * base UOM UNIT) and skips one that already exists. So "the book has never
 * heard of this" is not a dead end, and it stopped being an acceptable reason
 * to refuse a salesperson's order.
 *
 * This is the whole answer to two problems at once:
 *
 *   - AMBIGUITY nothing else could settle. Four sofa models, GINA-(SS),
 *     SGABELLO: the account book holds two brand items and a SALES ORDER cannot
 *     choose, because it does not learn the brand until purchasing does — the
 *     owner's words, "开 SO 的时候 PO 还没开". Picking one by alphabet would be
 *     a silent coin flip, and measured on 658 real sofa lines no single brand
 *     item is right for more than about 70% of them.
 *   - CODES THE BOOK NEVER HELD. Whole ranges of newer products are in no
 *     cutover row at all, and every order containing one was refused outright.
 *
 * Safe because an ERP item code cannot be typed. SoLineCard refuses text that
 * matches no catalogue product ("typed text that matches NO catalog product can
 * never become a line"), so the only strings that reach here are codes someone
 * already opened in the ERP's own product master.
 *
 * Old documents are untouched: composeEdit omits ItemCode for a line AutoCount
 * already owns, so an order sitting on a brand item stays on it forever.
 */
const canonicalOwnCode = (erpItemCode: string): string => erpItemCode.trim();

/**
 * The answer for a document with no creditor to ask — steps 3 to 5 of the
 * owner's chain, in order. Never returns null: step 5 always has an answer.
 */
function chooseWithoutSupplier(
  ownCode: string,
  code: string,
  candidates: AcItemMapEntry[],
): { acItemCode: string; via: 'same-name' | 'preferred-supplier' | 'erp-canonical' } {
  /* 3. The book already calls it what we call it. Worth more than any
        preference: it is not a guess, it is a match. Recovers HB709NL and the
        four DL-CS2 mattresses, where the OTHER candidate is a mis-mapped row
        and an alphabetical tie-break would have picked it. */
  const sameName = candidates.find((e) => up(e.ac) === code);
  if (sameName) return { acItemCode: sameName.ac, via: 'same-name' };

  /* 4. The owner's supplier preference. Only when it narrows to exactly one —
        two HOK items for one ERP code is still a question nobody answered. */
  for (const prefix of SUPPLIER_PREFERENCE) {
    const hit = candidates.filter((e) => up(e.ac).startsWith(`${prefix}-`));
    if (hit.length === 1) return { acItemCode: hit[0].ac, via: 'preferred-supplier' };
  }

  /* 5. Our own code. */
  return { acItemCode: canonicalOwnCode(ownCode), via: 'erp-canonical' };
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
  /* What "our own code" means for this line — see canonicalOwnCode. */
  let ownCode = erpItemCode;

  /* A sofa compartment has no AutoCount item of its own — the whole point of
     D9 is that AutoCount holds ONE line for the build. So the compartment
     resolves through the model's base SKU, plus every AutoCount model the
     cutover folded onto this ERP model (SOFA_MODEL_ALIAS). Including the alias
     sources is what makes the answer honest: ERP model 8030 really does stand
     for three different AutoCount items, and pretending otherwise would pick
     one of them at random. */
  if (!candidates.length) {
    const split = splitSofaCode(erpItemCode);
    /* RESOLVE THE COMPARTMENT AS ITS BUILD, by asking the same question of the
       model base code. D9 always collapses before the composer resolves, so the
       base code's answer is the one that reaches AutoCount — and a compartment
       resolved on its own has to match it or the ERP opens two items for one
       sofa depending on which side of the collapse the caller sits.
       They really did diverge: the alias expansion below pulls in every
       AutoCount model the cutover folded onto this ERP model, so a compartment
       of 9028 saw HOK-5530 SOFA (via the alias) and took it on the HOK
       preference, while 9028-1S itself sees only the two brand items and falls
       through to its own code. Guarded on the base differing from the input so
       a base code can never recurse into itself. */
    if (split) {
      const base = up(`${split.model}-1S`);
      if (base !== code) return resolveAcItemCode(base, opts);
      via = 'sofa-model';
      /* A compartment's own code is not an item in anybody's book — the whole
         point of D9 is that AutoCount holds ONE line for the build. So when we
         fall back to our own code it must be the MODEL BASE, the same string
         the collapsed line carries, or resolving one line at a time and
         resolving the built document would open two different items. */
      ownCode = `${split.model}-1S`;
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
    /* Otherwise IGNORE it and let the chain below decide. It used to refuse
       here, which was right while there was no other answer — but blocking a
       salesperson's order on a typo in a column that belongs to purchasing is
       not. The bad rows stay visible: check-autocount-ambiguous-items.mjs
       validates every binding against the book and lists them. */
  }

  /* Nothing in the book under this code — whole product ranges opened after the
     2026-08-05 snapshot are like this. Open it under our own name rather than
     refusing the document. */
  if (!candidates.length) {
    return { ok: true, acItemCode: canonicalOwnCode(ownCode), via: 'erp-canonical' };
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

  /* No creditor to ask — and on a SALES ORDER there never is one, because the
     purchase order does not exist yet when the order is written back. */
  return { ok: true, ...chooseWithoutSupplier(ownCode, code, candidates) };
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
