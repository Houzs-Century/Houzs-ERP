// ----------------------------------------------------------------------------
// supplier-rebates — a supplier's rebates on what the company buys from it,
// estimated month by month for the selling department's own P&L in Performance
// (owner 2026-11-27: his supplier's terms; 「这个rebate 只有houzs有哦」; 「其实这个是用在
// department的 performance exhibition department 罢了」). The rules are the
// company's own (acc_department_settings.supplier_rebates); the supplier's real
// credit notes stay as booked, in Actual.
//
//   Sponsor  its rate × (the month's purchases − the named products − accessories)
//            (「这3款不算」; the PJ showroom's goods are not taken off: 「可以，先不扣」)
//   Sales    the tier's rate × (the month's purchases − the display sets), the tier
//            read on that base; a display set is what the supplier's display-discount
//            credit notes are a discount on — their total ÷ the discount rate
//            (「这个减的就是display set」)
//
// A month's purchases are the supplier's bills dated in it — purchase invoices and
// AP invoices, neither cancelled nor draft.
// ----------------------------------------------------------------------------

import { fmtMoneySen } from '../shared/format';

export type RebateTier = { fromSen: number; bp: number };

/** One supplier's terms as Finance typed them. `namedWords`: the products the sponsor rebate
    leaves out, by a word of their name. `accessoryWords`: an accessory on a bill line that
    names no product, by a word of its description. `salesTiers`: ascending by `fromSen`;
    below the first, no sales rebate. `displayDiscountBp`: the discount the supplier's
    display credit notes give. */
export type SupplierRebateRule = {
  supplierCode: string;
  label: string;
  sponsorBp: number;
  namedWords: string[];
  accessoryWords: string[];
  salesTiers: RebateTier[];
  displayDiscountBp: number;
};

const words = (v: unknown): string[] =>
  (Array.isArray(v) ? [...new Set(v.map((w) => String(w ?? '').trim().toUpperCase()).filter(Boolean))] : []);
const bpOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
};
const senOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : -1;
};

/** The stored rules, checked: a rule without a supplier, or with nothing to earn, is dropped. */
export function parseSupplierRebates(raw: unknown): SupplierRebateRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SupplierRebateRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const supplierCode = String(r.supplierCode ?? '').trim().toUpperCase();
    if (!supplierCode) continue;
    const salesTiers = (Array.isArray(r.salesTiers) ? r.salesTiers : [])
      .map((t) => (t && typeof t === 'object' ? { fromSen: senOf((t as Record<string, unknown>).fromSen), bp: bpOf((t as Record<string, unknown>).bp) } : null))
      .filter((t): t is RebateTier => t !== null && t.fromSen >= 0 && t.bp > 0)
      .sort((a, b) => a.fromSen - b.fromSen);
    const rule: SupplierRebateRule = {
      supplierCode,
      label: String(r.label ?? '').trim() || supplierCode,
      sponsorBp: bpOf(r.sponsorBp),
      namedWords: words(r.namedWords),
      accessoryWords: words(r.accessoryWords),
      salesTiers,
      displayDiscountBp: bpOf(r.displayDiscountBp),
    };
    if (rule.sponsorBp === 0 && rule.salesTiers.length === 0) continue;
    out.push(rule);
  }
  return out;
}

/** One bill line from the supplier, as the rebates read it. */
export type RebateLineKind = 'named' | 'accessory' | 'counted';
export type RebatePurchaseLine = { month: string; day: string; docNo: string; text: string; sen: number; kind: RebateLineKind };
/** One display-discount credit note from the supplier. */
export type RebateDisplayNote = { month: string; day: string; noteNo: string; sen: number };

/** What the sponsor rebate makes of a bill line: a named product, an accessory (its
    product's category, or — with no product — a word of its description), or counted. */
export function rebateLineKind(rule: Pick<SupplierRebateRule, 'namedWords' | 'accessoryWords'>, text: string, category: string | null): RebateLineKind {
  const t = text.toUpperCase();
  if (rule.namedWords.some((w) => t.includes(w))) return 'named';
  if (category != null) return category.toUpperCase() === 'ACCESSORY' ? 'accessory' : 'counted';
  return rule.accessoryWords.some((w) => t.includes(w)) ? 'accessory' : 'counted';
}

export type RebateMonth = {
  month: string;
  purchasesSen: number;
  namedSen: number;
  accessorySen: number;
  sponsorBaseSen: number;
  sponsorSen: number;
  displayNotesSen: number;
  displaySetSen: number;
  salesBaseSen: number;
  salesBp: number;
  salesSen: number;
};

const ofBp = (sen: number, bp: number): number => Math.round((sen * bp) / 10_000);

/** The tier a month's base reaches: the highest whose threshold it meets, else none. */
export function tierBp(tiers: readonly RebateTier[], baseSen: number): number {
  let bp = 0;
  for (const t of tiers) if (baseSen >= t.fromSen) bp = t.bp;
  return bp;
}

/** Each month's two estimates and the figures they stand on. */
export function rebateMonths(
  rule: SupplierRebateRule, months: readonly string[], lines: readonly RebatePurchaseLine[], notes: readonly RebateDisplayNote[],
): RebateMonth[] {
  return months.map((month) => {
    const mine = lines.filter((l) => l.month === month);
    const sum = (k: RebateLineKind | null) => mine.filter((l) => k == null || l.kind === k).reduce((s, l) => s + l.sen, 0);
    const purchasesSen = sum(null);
    const namedSen = sum('named');
    const accessorySen = sum('accessory');
    const sponsorBaseSen = Math.max(0, purchasesSen - namedSen - accessorySen);
    const displayNotesSen = notes.filter((n) => n.month === month).reduce((s, n) => s + n.sen, 0);
    const displaySetSen = rule.displayDiscountBp > 0 ? Math.round((displayNotesSen * 10_000) / rule.displayDiscountBp) : 0;
    const salesBaseSen = Math.max(0, purchasesSen - displaySetSen);
    const salesBp = tierBp(rule.salesTiers, salesBaseSen);
    return {
      month, purchasesSen, namedSen, accessorySen, sponsorBaseSen, sponsorSen: ofBp(sponsorBaseSen, rule.sponsorBp),
      displayNotesSen, displaySetSen, salesBaseSen, salesBp, salesSen: ofBp(salesBaseSen, salesBp),
    };
  });
}

/** A rate in basis points, in words: 1500 → "15%", 250 → "2.5%". */
export const bpWords = (bp: number): string => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** The two lines a rule adds to the selling department's other income, by month. */
export type RebateFigure = { id: string; label: string; cells: Record<string, number> };

/** The keys the two lines go by — what a figure opened sends back. */
export const rebateKey = (supplierCode: string, kind: 'sponsor' | 'sales'): string => `rebate:${supplierCode}:${kind}`;

export function rebateFigures(rule: SupplierRebateRule, months: readonly RebateMonth[]): RebateFigure[] {
  const cells = (pick: (m: RebateMonth) => number) =>
    Object.fromEntries(months.map((m) => [m.month, pick(m)] as const).filter(([, v]) => v !== 0));
  const tiers = rule.salesTiers.map((t) => `${bpWords(t.bp)} from ${(t.fromSen / 100).toLocaleString('en-US')}`).join(', ');
  const out: RebateFigure[] = [];
  if (rule.sponsorBp > 0) {
    out.push({
      id: rebateKey(rule.supplierCode, 'sponsor'),
      label: `${rule.label} sponsor rebate (estimate) — ${bpWords(rule.sponsorBp)} of purchases, less ${rule.namedWords.length > 0 ? `${rule.namedWords.join(', ')} and ` : ''}accessories`,
      cells: cells((m) => m.sponsorSen),
    });
  }
  if (rule.salesTiers.length > 0) {
    out.push({
      id: rebateKey(rule.supplierCode, 'sales'),
      label: `${rule.label} sales rebate (estimate) — ${tiers} of purchases less display sets`,
      cells: cells((m) => m.salesSen),
    });
  }
  return out.filter((f) => Object.keys(f.cells).length > 0);
}

/** A month's working behind one of the two figures, in words — what the figure opened shows. */
export function rebateWorking(rule: SupplierRebateRule, m: RebateMonth, kind: 'sponsor' | 'sales'): string {
  if (kind === 'sponsor') {
    const named = rule.namedWords.length > 0 ? rule.namedWords.join(', ') : 'the named products';
    return `${bpWords(rule.sponsorBp)} of ${fmtMoneySen(m.sponsorBaseSen)}: the month's ${rule.label} bills ${fmtMoneySen(m.purchasesSen)}, `
      + `less ${named} ${fmtMoneySen(m.namedSen)} and accessories ${fmtMoneySen(m.accessorySen)}`;
  }
  return `${bpWords(m.salesBp)} of ${fmtMoneySen(m.salesBaseSen)}: the month's ${rule.label} bills ${fmtMoneySen(m.purchasesSen)}, `
    + `less display sets ${fmtMoneySen(m.displaySetSen)} (display discount notes ${fmtMoneySen(m.displayNotesSen)} at ${bpWords(rule.displayDiscountBp)})`;
}

/** The most suppliers a company keeps a rule for, the most tiers in one rule, the most words in one list. */
export const MAX_REBATE_RULES = 10;
export const MAX_REBATE_TIERS = 10;
export const MAX_REBATE_WORDS = 30;

/**
 * Rules as Finance sends them from the Department P&L (owner 2026-11-27: 「做设定框」),
 * checked strictly — every refusal names what to fix. What a read finds is
 * parseSupplierRebates's; what a save keeps is this.
 */
export function readSupplierRebateRules(raw: unknown): { ok: true; rules: SupplierRebateRule[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'Send the rules as a list.' };
  if (raw.length > MAX_REBATE_RULES) return { ok: false, message: `Keep to ${MAX_REBATE_RULES} suppliers.` };
  const rules: SupplierRebateRule[] = [];
  for (const [i, item] of raw.entries()) {
    const n = `Rule ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, message: `${n} is not a rule.` };
    const r = item as Record<string, unknown>;
    const supplierCode = String(r.supplierCode ?? '').trim().toUpperCase();
    if (!supplierCode) return { ok: false, message: `${n}: which supplier? Give its code.` };
    if (rules.some((x) => x.supplierCode === supplierCode)) return { ok: false, message: `${supplierCode} has two rules — keep one.` };
    const rate = (v: unknown, what: string): number | string => {
      const k = Number(v ?? 0);
      return Number.isInteger(k) && k >= 0 && k <= 10_000 ? k : `${supplierCode}: the ${what} is a percentage from 0 to 100, two decimals at most.`;
    };
    const sponsorBp = rate(r.sponsorBp, 'sponsor rebate');
    if (typeof sponsorBp === 'string') return { ok: false, message: sponsorBp };
    const displayDiscountBp = rate(r.displayDiscountBp, 'display discount');
    if (typeof displayDiscountBp === 'string') return { ok: false, message: displayDiscountBp };
    const wordList = (v: unknown, what: string): string[] | string => {
      if (v == null) return [];
      if (!Array.isArray(v) || v.length > MAX_REBATE_WORDS) return `${supplierCode}: the ${what} is a list of at most ${MAX_REBATE_WORDS} words.`;
      return words(v);
    };
    const namedWords = wordList(r.namedWords, 'products left out');
    if (typeof namedWords === 'string') return { ok: false, message: namedWords };
    const accessoryWords = wordList(r.accessoryWords, 'accessory words');
    if (typeof accessoryWords === 'string') return { ok: false, message: accessoryWords };
    const rawTiers = r.salesTiers == null ? [] : r.salesTiers;
    if (!Array.isArray(rawTiers) || rawTiers.length > MAX_REBATE_TIERS) return { ok: false, message: `${supplierCode}: at most ${MAX_REBATE_TIERS} sales rebate tiers.` };
    const salesTiers: RebateTier[] = [];
    for (const t of rawTiers) {
      const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      const fromSen = Number(o.fromSen);
      const bp = Number(o.bp);
      if (!Number.isInteger(fromSen) || fromSen < 0) return { ok: false, message: `${supplierCode}: a sales rebate tier starts at an amount of 0 or more.` };
      if (!Number.isInteger(bp) || bp <= 0 || bp > 10_000) return { ok: false, message: `${supplierCode}: a sales rebate tier's rate is above 0 and at most 100%.` };
      const last = salesTiers.at(-1);
      if (last && fromSen <= last.fromSen) return { ok: false, message: `${supplierCode}: list the sales rebate tiers from the lowest amount up, each higher than the one before.` };
      salesTiers.push({ fromSen, bp });
    }
    if (sponsorBp === 0 && salesTiers.length === 0) return { ok: false, message: `${supplierCode} earns nothing — give a sponsor rebate rate or a sales rebate tier.` };
    rules.push({
      supplierCode, label: String(r.label ?? '').trim().slice(0, 60) || supplierCode,
      sponsorBp, namedWords, accessoryWords, salesTiers, displayDiscountBp,
    });
  }
  return { ok: true, rules };
}
