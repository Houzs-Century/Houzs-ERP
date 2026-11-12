// The combo screen's view of the rows. A combo the user sees is one model + module
// set; underneath it is one rule per Price (and one per supplier). Everything here
// is pure so the screen and the Excel file read the same answer.

import { buildComboLabel, comboSlotsKey, fmtSen, type SofaPriceTier } from '@2990s/shared';
import type { ApplyComboItem, SofaComboRule } from '../../lib/sofa-combos-queries';

export const PRICE_TIERS: readonly SofaPriceTier[] = ([1, 2, 3, 4] as const).map((n): SofaPriceTier => `PRICE_${n}`);
export const tierLabel = (t: SofaPriceTier): string => t.replace('PRICE_', 'Price ');
export const heightLabel = (h: string): string => (/^\d+$/.test(h) ? `${h}"` : h);
export const rm = (sen: number): string => fmtSen(sen);

export type ComboLine = {
  key: string;
  baseModel: string;
  modules: string[][];
  /** What the combo is called; `name` adds a number when a model repeats it. */
  label: string;
  name: string;
  byTier: Partial<Record<SofaPriceTier, SofaComboRule>>;
};

export const comboKey = (baseModel: string, modules: readonly (readonly string[])[]): string =>
  JSON.stringify([baseModel, comboSlotsKey(modules)]);

const newestFirst = (a: SofaComboRule, b: SofaComboRule): number =>
  (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0)
  || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** Combos per model, in name order. A name that repeats inside a model gets a number:
 *  the Excel file finds a combo again by its name. */
export function comboBook(rules: readonly SofaComboRule[]): Map<string, ComboLine[]> {
  const lines = new Map<string, ComboLine>();
  for (const r of [...rules].sort(newestFirst)) {
    const key = comboKey(r.baseModel, r.modules);
    const line = lines.get(key) ?? {
      key, baseModel: r.baseModel, modules: r.modules, label: r.label || buildComboLabel(r.modules), name: r.label || buildComboLabel(r.modules), byTier: {},
    };
    line.byTier[r.tier ?? 'PRICE_1'] ??= r;
    lines.set(key, line);
  }
  const book = new Map<string, ComboLine[]>();
  for (const line of lines.values()) book.set(line.baseModel, [...(book.get(line.baseModel) ?? []), line]);
  for (const list of book.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Map<string, number>();
    for (const line of list) {
      const n = (seen.get(line.name) ?? 0) + 1;
      seen.set(line.name, n);
      if (n > 1) line.name = `${line.name} (${n})`;
    }
  }
  return book;
}

export const costAt = (line: ComboLine, tier: SofaPriceTier, h: string): number | null =>
  line.byTier[tier]?.pricesByHeight[h] ?? null;

export const hasPrice = (line: ComboLine): boolean =>
  Object.values(line.byTier).some((r) => Object.values(r.pricesByHeight).some((v) => v != null));

/** The sizes a model has a price at, on any Price. An old row can hold its price only
 *  in the selling grid, and that size still has to show. */
export function sizesInUse(lines: readonly ComboLine[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    for (const r of Object.values(line.byTier)) {
      for (const grid of [r.pricesByHeight, r.sellingPricesByHeight ?? {}]) {
        for (const [h, v] of Object.entries(grid)) if (v != null) out.add(h);
      }
    }
  }
  return out;
}

export const sortSizes = (sizes: Iterable<string>): string[] =>
  [...sizes].sort((a, b) => {
    const na = Number.parseFloat(a);
    const nb = Number.parseFloat(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
      return Number.isNaN(na) ? 1 : -1;
    }
    return na - nb || a.localeCompare(b);
  });

/** The sizes a model is sold in: its own list when it has one, else the Maintenance
 *  master, so a size added there shows up here. A size already priced always stays. */
export const offeredSizes = (own: readonly string[] | undefined, master: readonly string[], priced: Iterable<string>): string[] =>
  sortSizes(new Set([...(own && own.length > 0 ? own : master), ...priced]));

const familyOf = (code: string): string => code.replace(/\((LHF|RHF)\)$/, '');

/** "1A(LHF) or 1A(RHF)" reads as one piece: 1A. */
export const slotBrief = (slot: readonly string[]): string => [...new Set(slot.map(familyOf))].join(' / ');
export const modulesBrief = (modules: readonly (readonly string[])[]): string => modules.map(slotBrief).join(' | ');

/** A slot on one line, however many modules it holds. */
export const slotLabel = (slot: readonly string[]): string =>
  (slot.length > 2 ? `${slot.slice(0, 2).join(' or ')} +${slot.length - 2} more` : slot.join(' or '));

/** A combo written for one model, read against the modules another has. `missing`
 *  names the pieces this model does not make; such a combo cannot be added. */
export function fitSlots(slots: readonly (readonly string[])[], own: readonly string[]): { modules: string[][]; missing: string[] } {
  const modules: string[][] = [];
  const missing: string[] = [];
  for (const slot of slots) {
    const kept = slot.filter((code) => own.includes(code));
    if (kept.length > 0) modules.push(kept);
    else missing.push(slotBrief(slot));
  }
  return { modules, missing };
}

/** A preset's slots (Presets, from the server) read against a model: a code with
 *  no side, "2A", stands for every side of it the model makes; "2A(LHF)" is that
 *  side only. A code the model does not make stays, so fitSlots names it missing. */
export const presetSlots = (slots: readonly (readonly string[])[], own: readonly string[]): string[][] =>
  slots.map((slot) => [...new Set(slot.flatMap((code) => {
    if (familyOf(code) !== code) return [code];
    const matches = own.filter((o) => familyOf(o) === code);
    return matches.length > 0 ? matches : [code];
  }))]);

/** A preset's slots on one line: "2A + CNR + 1A", alternatives as "1A or 1B". */
export const presetPieces = (slots: readonly (readonly string[])[]): string => slots.map((slot) => slot.join(' or ')).join(' + ');

/** Every module code a preset slot may hold: each side, and the plain code for "either side". */
export const presetModuleCodes = (codes: readonly string[]): string[] => [...new Set([...codes, ...codes.map(familyOf)])].sort();

export type ModuleFamily = { code: string; group: string; variants: Array<{ code: string; label: string }> };

/** A piece matches on its code or on the name of any of its sides. */
export const familyMatches = (f: ModuleFamily, query: string, names: Readonly<Record<string, string>>): boolean => {
  const q = query.trim().toLowerCase();
  return f.code.toLowerCase().includes(q) || f.variants.some((v) => (names[v.code] ?? '').toLowerCase().includes(q));
};
export const MODULE_GROUPS = ['1 seat', '2 seat', '3 seat', 'Chaise', 'Corner', 'Other'] as const;

const groupOf = (family: string): string => {
  if (family.startsWith('1')) return '1 seat';
  if (family.startsWith('2')) return '2 seat';
  if (family.startsWith('3')) return '3 seat';
  if (family === 'L' || family.startsWith('L(')) return 'Chaise';
  if (family.startsWith('CNR')) return 'Corner';
  return 'Other';
};

/** LHF and RHF of one piece sit on one row of the picker. */
export function moduleFamilies(codes: readonly string[]): ModuleFamily[] {
  const map = new Map<string, ModuleFamily>();
  for (const code of [...codes].sort()) {
    const family = familyOf(code);
    const entry = map.get(family) ?? { code: family, group: groupOf(family), variants: [] };
    const side = /\((LHF|RHF)\)$/.exec(code)?.[1];
    entry.variants.push({ code, label: side ?? 'Add' });
    map.set(family, entry);
  }
  return [...map.values()];
}

export type ModelEntry = { code: string; name: string; supplierCode: string | null; combos: number };

/** The list on the left: models that have combos, unless asked for all or searching.
 *  A search looks everywhere, and the open model never drops out from under you. */
export function listedModels(all: readonly ModelEntry[], query: string, showAll: boolean, open: string | null): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (q) return all.filter((m) => `${m.code} ${m.name} ${m.supplierCode ?? ''}`.toLowerCase().includes(q));
  return showAll ? [...all] : all.filter((m) => m.combos > 0 || m.code === open);
}

export type HistoryLine = { id: string; date: string; who: string; what: string; detail: string };

/** One line per thing that changed, newest first, from a tuple's rows. */
export function historyLines(rows: readonly SofaComboRule[]): HistoryLine[] {
  const ordered = [...rows].sort(newestFirst).reverse();
  const out: HistoryLine[] = [];
  ordered.forEach((row, i) => {
    const who = row.createdByName ?? '';
    const prev = i > 0 ? ordered[i - 1] : null;
    if (!prev) {
      out.push({ id: row.id, date: row.effectiveFrom, who, what: 'Created', detail: row.notes });
      return;
    }
    let any = false;
    for (const h of sortSizes(new Set([...Object.keys(prev.pricesByHeight), ...Object.keys(row.pricesByHeight)]))) {
      const was = prev.pricesByHeight[h] ?? null;
      const now = row.pricesByHeight[h] ?? null;
      if (was === now) continue;
      any = true;
      let detail = `${rm(was ?? 0)} to ${rm(now ?? 0)}`;
      if (was === null) detail = `First price ${rm(now ?? 0)}`;
      else if (now === null) detail = `${rm(was)} removed`;
      out.push({ id: `${row.id}:${h}`, date: row.effectiveFrom, who, what: `${heightLabel(h)} seat`, detail });
    }
    if (!any) out.push({ id: row.id, date: row.effectiveFrom, who, what: row.label === prev.label ? 'Changed' : 'Renamed', detail: row.notes });
  });
  return out.reverse();
}

export const parseRm = (raw: string): number | null => {
  const text = raw.replace(/,/g, '').replace(/^RM\s*/i, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export const editKey = (line: ComboLine, tier: SofaPriceTier, h: string): string => JSON.stringify([line.key, tier, h]);

/** The typed cells as one write per combo and Price. Empty on a priced cell takes the
 *  price away; a cell back at its own value is no change. `bad` names what is not a price. */
export function itemsFromEdits(
  edits: Readonly<Record<string, string>>,
  lines: ReadonlyMap<string, ComboLine>,
  supplierId: string | null,
  effectiveFrom: string,
): { items: ApplyComboItem[]; bad: string | null } {
  const byTuple = new Map<string, ApplyComboItem>();
  let bad: string | null = null;
  for (const [key, typed] of Object.entries(edits)) {
    const [lineKey, tier, h] = JSON.parse(key) as [string, SofaPriceTier, string];
    const line = lines.get(lineKey);
    if (!line) continue;
    const had = costAt(line, tier, h);
    const blank = typed.trim() === '';
    const next = blank ? null : parseRm(typed);
    if (!blank && next === null) { bad = typed; continue; }
    if (next === had) continue;
    const tupleKey = JSON.stringify([lineKey, tier]);
    const item = byTuple.get(tupleKey) ?? {
      baseModel: line.baseModel, modules: line.modules, tier, supplierId, prices: {}, effectiveFrom,
    };
    item.prices[h] = next;
    byTuple.set(tupleKey, item);
  }
  return { items: [...byTuple.values()], bad };
}
