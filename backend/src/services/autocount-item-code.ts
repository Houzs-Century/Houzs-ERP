import { AC_ITEM_MAP_TSV, AC_ITEM_MAP_ROWS } from './autocount-item-map';
import { splitSofaCode } from './autocount-sofa-collapse';
import { SOFA_MODEL_ALIAS } from '../../scripts/lib/parse-sofa.mjs';

export interface AcItemMapEntry {
  ac: string;
  erp: string;
  category: string;
  supplier: string | null;
}

export interface AcItemIndex {
  byErp: Map<string, AcItemMapEntry[]>;
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

function chooseWithoutSupplier(
  erpItemCode: string,
  code: string,
  candidates: AcItemMapEntry[],
): { acItemCode: string; via: 'same-name' | 'preferred-supplier' | 'erp-canonical' } {
  const sameName = candidates.find((e) => up(e.ac) === code);
  if (sameName) return { acItemCode: sameName.ac, via: 'same-name' };

  for (const prefix of SUPPLIER_PREFERENCE) {
    const hit = candidates.filter((e) => up(e.ac).startsWith(`${prefix}-`));
    if (hit.length === 1) return { acItemCode: hit[0].ac, via: 'preferred-supplier' };
  }

  return { acItemCode: canonicalOwnCode(erpItemCode), via: 'erp-canonical' };
}

export function resolveAcItemCode(
  erpItemCode: string,
  opts: {
    supplierCode?: string | null;
    index?: AcItemIndex;
    bindings?: Map<string, string> | null;
  } = {},
): ItemCodeResolution {
  const index = opts.index ?? acItemIndex();
  const code = up(erpItemCode);
  if (!code) return { ok: false, reason: 'unmapped', detail: 'the ERP line has no item code', candidates: [] };

  const bound = opts.bindings?.get(code);
  let candidates = index.byErp.get(code) ?? [];
  let via: 'direct' | 'sofa-model' = 'direct';

  if (!candidates.length) {
    const split = splitSofaCode(erpItemCode);
    if (split && up(split.compartment) === '1S') {
      via = 'sofa-model';
      const seen = new Set<string>();
      const acc: AcItemMapEntry[] = [];
      for (const m of ALIAS_SOURCES.get(up(split.model)) ?? []) {
        for (const e of index.byErp.get(up(`${m}-1S`)) ?? []) {
          if (seen.has(e.ac)) continue;
          seen.add(e.ac);
          acc.push(e);
        }
      }
      candidates = acc;
    }
  }

  if (bound && (candidates.length <= 1 || index.acCodes.has(up(bound)))) {
    return { ok: true, acItemCode: bound, via: 'binding' };
  }

  if (!candidates.length) {
    return { ok: true, acItemCode: canonicalOwnCode(erpItemCode), via: 'erp-canonical' };
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

  return { ok: true, ...chooseWithoutSupplier(erpItemCode, code, candidates) };
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
