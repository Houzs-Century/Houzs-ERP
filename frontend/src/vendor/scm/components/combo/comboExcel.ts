// The combo Excel file: one sheet for each of Price 1 to 4, laid out like the screen
// (a row per combo, a column per size), plus a Modules sheet. Export and Import live
// together so a file always reads back what was written.

import { fmtDate, type SofaPriceTier } from '@2990s/shared';
import { parseDmy } from '../DateField';
import type { ApplyComboItem } from '../../lib/sofa-combos-queries';
import type { XlsxCell, XlsxSheet } from '../../lib/styled-xlsx';
import { comboKey, costAt, heightLabel, modulesBrief, parseRm, PRICE_TIERS, rm, sortSizes, tierLabel, type ComboLine } from './comboBook';

const MODULES_SHEET = 'Modules';
const MIN_SLOT_COLUMNS = 4;

const allSizes = (lines: readonly ComboLine[]): string[] => {
  const sizes = new Set<string>();
  for (const line of lines) {
    for (const r of Object.values(line.byTier)) for (const h of Object.keys(r.pricesByHeight)) sizes.add(h);
  }
  return sortSizes(sizes);
};

/** The sizes a model offers in this file: those priced on any of its combos. A model
 *  with no price yet has none to go by, so every column is open to it. */
function modelSizes(lines: readonly ComboLine[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of lines) {
    const set = out.get(line.baseModel) ?? new Set<string>();
    for (const r of Object.values(line.byTier)) {
      for (const [h, v] of Object.entries(r.pricesByHeight)) if (v != null) set.add(h);
    }
    out.set(line.baseModel, set);
  }
  return out;
}

export function comboSheets(lines: readonly ComboLine[], supplierName: string | null, fallbackSizes: readonly string[]): XlsxSheet[] {
  const used = allSizes(lines).filter((h) => lines.some((l) => Object.values(l.byTier).some((r) => r.pricesByHeight[h] != null)));
  const sizes = used.length > 0 ? used : sortSizes(fallbackSizes);
  const offered = modelSizes(lines);
  const head = [...(supplierName === null ? [] : ['Supplier']), 'Model', 'Combo', 'Modules'];
  const headerRow: XlsxCell[] = [...head, ...sizes, 'Effective from', 'Notes'].map((v) => ({ v, s: 'header' }));

  const priceSheets = PRICE_TIERS.map((tier): XlsxSheet => ({
    name: tierLabel(tier),
    widths: [...head.map((h) => (h === 'Combo' ? 26 : h === 'Modules' ? 18 : 16)), ...sizes.map(() => 11), 14, 18],
    freeze: { rows: 1, cols: head.length },
    rows: [headerRow, ...lines.map((line): XlsxCell[] => {
      const rule = line.byTier[tier];
      const has = offered.get(line.baseModel) ?? new Set<string>();
      return [
        ...(supplierName === null ? [] : [{ v: supplierName, s: 'read' as const }]),
        { v: line.baseModel, s: 'read' },
        { v: line.name, s: 'read' },
        { v: modulesBrief(line.modules), s: 'read' },
        ...sizes.map((h): XlsxCell => {
          const sen = costAt(line, tier, h);
          if (sen !== null) return { v: sen / 100, s: 'money' };
          return { v: null, s: has.size === 0 || has.has(h) ? 'fill' : 'none' };
        }),
        { v: rule ? fmtDate(rule.effectiveFrom) : '' },
        { v: '' },
      ];
    })],
  }));

  const slotCount = Math.max(MIN_SLOT_COLUMNS, ...lines.map((l) => l.modules.length));
  const slotHeads = Array.from({ length: slotCount }, (_, i) => `Slot ${i + 1}`);
  return [...priceSheets, {
    name: MODULES_SHEET,
    widths: [16, 26, ...slotHeads.map(() => 24), 9],
    freeze: { rows: 1, cols: 2 },
    rows: [
      ['Model', 'Combo', ...slotHeads, 'Delete'].map((v): XlsxCell => ({ v, s: 'header' })),
      ...lines.map((line): XlsxCell[] => [
        { v: line.baseModel },
        { v: line.name },
        ...slotHeads.map((_, i): XlsxCell => ({ v: (line.modules[i] ?? []).join(' | ') })),
        { v: '' },
      ]),
    ],
  }];
}

export async function downloadComboWorkbook(sheets: readonly XlsxSheet[], fileName: string): Promise<void> {
  const { buildStyledXlsx } = await import('../../lib/styled-xlsx');
  const bytes = buildStyledXlsx(sheets);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export type ComboGrids = Partial<Record<string, string[][]>>;

export async function readComboFile(file: File): Promise<ComboGrids> {
  const { read, utils } = await import('../../../../lib/xlsx-runtime');
  const wb = read(await file.arrayBuffer(), { type: 'array' });
  const grids: ComboGrids = {};
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name] as Parameters<typeof utils.sheet_to_json>[0];
    const rows = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
    grids[name] = rows.map((row) => row.map((v) => String(v ?? '').trim()));
  }
  return grids;
}

export type ImportChange = { kind: string; where: string; before: string; after: string };

export type ComboImportPlan = {
  changes: ImportChange[];
  refused: string[];
  /** Run in this order: a recompose moves a combo, so prices written after it land on the new modules. */
  recompose: Array<{ baseModel: string; from: string[][]; to: string[][] }>;
  retire: Array<{ baseModel: string; modules: string[][] }>;
  apply: ApplyComboItem[];
};

type PlanContext = {
  lines: readonly ComboLine[];
  /** Every model this company has, with the modules it makes. */
  modulesByModel: Partial<Record<string, readonly string[]>>;
  supplierId: string | null;
  supplierName: string | null;
  today: string;
};

const parseSlotCell = (cell: string): string[] => cell.split('|').map((c) => c.trim()).filter(Boolean);

export function planComboImport(grids: ComboGrids, ctx: PlanContext): ComboImportPlan {
  const plan: ComboImportPlan = { changes: [], refused: [], recompose: [], retire: [], apply: [] };
  const named = new Map(ctx.lines.map((l) => [JSON.stringify([l.baseModel, l.name]), l]));
  const nameKey = (model: string, name: string) => JSON.stringify([model, name]);
  const gone = new Set<string>();
  const movedTo = new Map<string, string[][]>();
  const fresh = new Map<string, string[][]>();

  const moduleRows = grids[MODULES_SHEET];
  if (moduleRows && moduleRows.length > 0) {
    const header = moduleRows[0] ?? [];
    const modelCol = header.indexOf('Model');
    const comboCol = header.indexOf('Combo');
    const deleteCol = header.indexOf('Delete');
    const slotCols = header.flatMap((h, i) => (/^Slot \d+$/.test(h) ? [i] : []));
    moduleRows.slice(1).forEach((row, i) => {
      const at = `Modules, row ${i + 2}`;
      const model = row[modelCol] ?? '';
      const name = row[comboCol] ?? '';
      if (!model && !name) return;
      const own = ctx.modulesByModel[model];
      if (!own) { plan.refused.push(`${at}: ${model || 'this row'} is not a model`); return; }
      const line = named.get(nameKey(model, name));
      if (/^y(es)?$/i.test(row[deleteCol] ?? '')) {
        if (!line) { plan.refused.push(`${at}: ${name} is not a combo of ${model}`); return; }
        plan.retire.push({ baseModel: model, modules: line.modules });
        plan.changes.push({ kind: 'Delete', where: `${model} ${name}`, before: 'Live', after: 'Deleted' });
        gone.add(nameKey(model, name));
        return;
      }
      const slots = slotCols.map((c) => parseSlotCell(row[c] ?? '')).filter((s) => s.length > 0);
      if (slots.length === 0) { plan.refused.push(`${at}: ${name || 'this combo'} has no modules`); return; }
      const wrong = slots.flat().filter((code) => own.length > 0 && !own.includes(code));
      if (wrong.length > 0) { plan.refused.push(`${at}: ${wrong.join(', ')} is not a module of ${model}`); return; }
      if (!line) {
        plan.apply.push({ baseModel: model, modules: slots, tier: 'PRICE_1', supplierId: ctx.supplierId, prices: {}, effectiveFrom: ctx.today, label: name || null });
        fresh.set(nameKey(model, name), slots);
        plan.changes.push({ kind: 'New combo', where: `${model} ${name}`, before: 'None', after: modulesBrief(slots) });
      } else if (comboKey(model, slots) !== line.key) {
        plan.recompose.push({ baseModel: model, from: line.modules, to: slots });
        movedTo.set(line.key, slots);
        plan.changes.push({ kind: 'Modules', where: `${model} ${name}`, before: modulesBrief(line.modules), after: modulesBrief(slots) });
      }
    });
  }

  for (const tier of PRICE_TIERS) {
    const sheetName = tierLabel(tier);
    const rows = grids[sheetName];
    if (!rows || rows.length === 0) continue;
    planPriceSheet(plan, rows, sheetName, tier, ctx, { named, gone, movedTo, fresh, nameKey });
  }
  return plan;
}

function planPriceSheet(
  plan: ComboImportPlan,
  rows: readonly string[][],
  sheetName: string,
  tier: SofaPriceTier,
  ctx: PlanContext,
  known: {
    named: ReadonlyMap<string, ComboLine>;
    gone: ReadonlySet<string>;
    movedTo: ReadonlyMap<string, string[][]>;
    fresh: ReadonlyMap<string, string[][]>;
    nameKey: (model: string, name: string) => string;
  },
): void {
  const header = rows[0] ?? [];
  const fixed = new Set(['Supplier', 'Model', 'Combo', 'Modules', 'Effective from', 'Notes']);
  const col = (name: string) => header.indexOf(name);
  const sizeCols = header.flatMap((h, i) => (h && !fixed.has(h) ? [{ h, i }] : []));

  rows.slice(1).forEach((row, i) => {
    const at = `${sheetName}, row ${i + 2}`;
    const model = row[col('Model')] ?? '';
    const name = row[col('Combo')] ?? '';
    if (!model && !name) return;
    if (known.gone.has(known.nameKey(model, name))) return;
    const supplierCell = col('Supplier') >= 0 ? (row[col('Supplier')] ?? '') : '';
    if (ctx.supplierName !== null && supplierCell && supplierCell !== ctx.supplierName) {
      plan.refused.push(`${at}: this row belongs to ${supplierCell}`);
      return;
    }
    const line = known.named.get(known.nameKey(model, name));
    const modules = line ? (known.movedTo.get(line.key) ?? line.modules) : known.fresh.get(known.nameKey(model, name));
    if (!modules) { plan.refused.push(`${at}: ${name} is not a combo of ${model}`); return; }

    const prices: ApplyComboItem['prices'] = {};
    let refused = false;
    for (const { h, i: c } of sizeCols) {
      const raw = (row[c] ?? '').trim();
      if (!raw) continue;
      const had = line ? costAt(line, tier, h) : null;
      if (/^x$/i.test(raw)) {
        if (had === null) continue;
        prices[h] = null;
        plan.changes.push({ kind: 'Remove', where: `${sheetName}: ${model} ${name}, ${heightLabel(h)}`, before: rm(had), after: 'Removed' });
        continue;
      }
      const sen = parseRm(raw);
      if (sen === null) { plan.refused.push(`${at}: ${raw} is not a price`); refused = true; continue; }
      if (sen === had) continue;
      prices[h] = sen;
      plan.changes.push({
        kind: had === null ? 'First price' : 'Price',
        where: `${sheetName}: ${model} ${name}, ${heightLabel(h)}`,
        before: had === null ? 'Empty' : rm(had),
        after: rm(sen),
      });
    }
    if (refused || Object.keys(prices).length === 0) return;

    const dateCell = row[col('Effective from')] ?? '';
    const typedDate = dateCell ? parseDmy(dateCell) : null;
    if (dateCell && !typedDate) { plan.refused.push(`${at}: ${dateCell} is not a date`); return; }
    // The export prints the date a price started. Left as it is, a new price starts
    // today rather than rewriting when the old one began.
    const current = line?.byTier[tier]?.effectiveFrom;
    const effectiveFrom = typedDate && typedDate !== current ? typedDate : ctx.today;
    const notes = row[col('Notes')] ?? '';
    plan.apply.push({ baseModel: model, modules, tier, supplierId: ctx.supplierId, prices, effectiveFrom, notes: notes || null });
  });
}

export const combosFileName = (scope: string, today: string): string =>
  `Combos ${scope.replace(/[^A-Za-z0-9 _-]+/g, ' ').trim()} ${today}.xlsx`;
