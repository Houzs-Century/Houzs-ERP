// ----------------------------------------------------------------------------
// sales-lines — one row per SOLD line, for the 2990 POS Marketing > Sales
// analysis (scm/routes/sales-analysis.ts GET /lines). Pure: the route loads the
// rows, this shapes them.
//
// A sofa build is several SO lines, one per compartment; it folds into ONE row
// whose `modules` run left to right, so the tablet can count sets, draw the
// build and name it. Every other line maps 1:1. Labels, filters and aggregates
// are the POS's: this sends facts.
// ----------------------------------------------------------------------------

import { ageFromBirthday } from '../shared/customer-demographics';
import { moduleCodeFromSku } from '../shared/sofa-build';

export interface SalesLinesOrder {
  docNo: string;
  /** 'YYYY-MM-DD' */
  soDate: string;
  venue: string | null;
  customerId: string | null;
  race: string | null;
  /** ISO date, as the POS handover captured it (mig 0162). */
  birthday: string | null;
  gender: string | null;
  state: string | null;
}

export interface SalesLinesItem {
  docNo: string;
  lineNo: number | null;
  itemCode: string;
  itemGroup: string | null;
  qty: number;
  totalSen: number;
  /** variants.buildKey — the POS's id for one sofa build within an SO. */
  buildKey: string | null;
  /** variants.cellIndex — the compartment's place along its build. */
  cellIndex: number | null;
}

export interface SalesLinesProduct {
  category: string;
  modelId: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  baseModel: string | null;
}

export interface SalesLine {
  docNo: string;
  soDate: string;
  venue: string | null;
  category: string;
  model: string;
  /** A sofa build's compartment codes, left to right; [] for anything else. */
  modules: string[];
  sizeCode: string | null;
  sizeLabel: string | null;
  qty: number;
  /** Revenue after discount, integer sen. A build sums its lines. */
  totalSen: number;
  customerId: string | null;
  race: string | null;
  /** The customer's age on the order date. The birthday itself is not sent. */
  age: number | null;
  gender: string | null;
  state: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

/** Age on the order date, or null for a missing or implausible birthday. */
const ageOn = (birthday: string | null, soDate: string): number | null => {
  const age = ageFromBirthday(birthday, soDate);
  return age != null && age >= 0 && age <= 120 ? age : null;
};

const byLine = (a: SalesLinesItem, b: SalesLinesItem): number =>
  (a.lineNo ?? Number.MAX_SAFE_INTEGER) - (b.lineNo ?? Number.MAX_SAFE_INTEGER) || a.itemCode.localeCompare(b.itemCode);

/** 0 for a left-arm compartment, 2 for a right-arm one, 1 for neither. */
const armRank = (module: string): number => (/\(LHF\)/i.test(module) ? 0 : /\(RHF\)/i.test(module) ? 2 : 1);

interface BuildPart { item: SalesLinesItem; module: string }

/** Left to right. The POS stamps each compartment's place on the build
 *  (cellIndex); a build missing one on any line is ordered left arm, armless,
 *  right arm instead, because line order is not reliable there — older orders
 *  keep the priced compartment first whichever side it sits on. */
function leftToRight(parts: BuildPart[]): BuildPart[] {
  const placed = parts.every((p) => p.item.cellIndex != null);
  return [...parts].sort((a, b) =>
    placed
      ? a.item.cellIndex! - b.item.cellIndex! || byLine(a.item, b.item)
      : armRank(a.module) - armRank(b.module) || byLine(a.item, b.item));
}

export function foldSalesLines(
  orders: readonly SalesLinesOrder[],
  items: readonly SalesLinesItem[],
  productByCode: ReadonlyMap<string, SalesLinesProduct>,
  modelNameById: ReadonlyMap<string, string>,
): SalesLine[] {
  const orderByDoc = new Map(orders.map((o) => [o.docNo, o]));
  const modelOf = (code: string, p: SalesLinesProduct | undefined): string =>
    (p?.modelId ? modelNameById.get(p.modelId) : undefined) || clean(p?.baseModel) || code;
  const header = (o: SalesLinesOrder) => ({
    docNo: o.docNo,
    soDate: o.soDate,
    venue: clean(o.venue),
    customerId: clean(o.customerId),
    race: clean(o.race),
    age: ageOn(clean(o.birthday), o.soDate),
    gender: clean(o.gender),
    state: clean(o.state),
  });

  const out: SalesLine[] = [];
  const builds = new Map<string, BuildPart[]>();
  /** `${docNo}|${BASE MODEL}` -> that doc's first keyed build of the model. */
  const keyedBuildOf = new Map<string, string>();
  const unkeyed: Array<{ item: SalesLinesItem; docModel: string; module: string }> = [];

  for (const item of [...items].sort((a, b) => a.docNo.localeCompare(b.docNo) || byLine(a, b))) {
    const o = orderByDoc.get(item.docNo);
    if (!o) continue;
    const p = productByCode.get(item.itemCode);
    const category = (p?.category || item.itemGroup || '').toUpperCase();
    if (category !== 'SOFA') {
      out.push({
        ...header(o),
        category,
        model: modelOf(item.itemCode, p),
        modules: [],
        sizeCode: clean(p?.sizeCode),
        sizeLabel: clean(p?.sizeLabel),
        qty: item.qty,
        totalSen: item.totalSen,
      });
      continue;
    }
    const base = clean(p?.baseModel);
    const module = moduleCodeFromSku(item.itemCode, base);
    const docModel = `${item.docNo}|${(base ?? item.itemCode.split('-')[0]).toUpperCase()}`;
    if (item.buildKey) {
      const key = `${item.docNo}|b:${item.buildKey}`;
      if (!builds.has(key)) builds.set(key, []);
      builds.get(key)!.push({ item, module });
      if (!keyedBuildOf.has(docModel)) keyedBuildOf.set(docModel, key);
    } else {
      unkeyed.push({ item, docModel, module });
    }
  }
  /* A compartment with no build key joins that order's build of the same Model
     (headrests added after the build was keyed); with none to join, the order's
     unkeyed compartments of one Model are one sofa (orders keyed before builds
     carried keys). */
  for (const u of unkeyed) {
    const key = keyedBuildOf.get(u.docModel) ?? `${u.docModel}|m`;
    if (!builds.has(key)) builds.set(key, []);
    builds.get(key)!.push({ item: u.item, module: u.module });
  }

  for (const parts of builds.values()) {
    const ordered = leftToRight(parts);
    const lead = ordered[0]!.item;
    out.push({
      ...header(orderByDoc.get(lead.docNo)!),
      category: 'SOFA',
      model: modelOf(lead.itemCode, productByCode.get(lead.itemCode)),
      modules: ordered.map((p) => p.module),
      sizeCode: null,
      sizeLabel: null,
      // Sets: every compartment appears once per set.
      qty: Math.min(...ordered.map((p) => p.item.qty)),
      totalSen: ordered.reduce((s, p) => s + p.item.totalSen, 0),
    });
  }
  return out.sort((a, b) => a.soDate.localeCompare(b.soDate) || a.docNo.localeCompare(b.docNo));
}
