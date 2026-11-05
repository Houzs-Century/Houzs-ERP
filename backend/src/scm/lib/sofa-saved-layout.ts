import { matchComboSubset } from '../shared/sofa-combo-pricing';
import { normalizeCompartmentCode } from '../shared/sofa-build';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;

/** Separate from module slots: an accessory is its own SKU and Model. */
export function validateComboAccessories(raw: unknown): Array<{ modelId: string; qty: number }> | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 200) return null;
  const counts = new Map<string, number>();
  for (const row of raw) {
    if (!object(row) || !id(row.modelId) || !Number.isSafeInteger(row.qty) || Number(row.qty) < 1 || Number(row.qty) > 200) return null;
    const modelId = row.modelId.trim();
    const qty = (counts.get(modelId) ?? 0) + Number(row.qty);
    if (qty > 200) return null;
    counts.set(modelId, qty);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([modelId, qty]) => ({ modelId, qty }));
}

export function comboAccessoriesKey(raw: unknown): string {
  return JSON.stringify(validateComboAccessories(raw) ?? []);
}

/** Snapshot geometry preserves attachment ids when a saved layout is reopened. */
export function validateSofaSavedLayout(raw: unknown, modules: string[][]): JsonObject | null | false {
  if (raw === undefined || raw === null) return null;
  if (!object(raw) || !Array.isArray(raw.cells) || raw.cells.length !== modules.length || raw.cells.length > 100) return false;
  const cellIds = new Set<string>();
  const cells: JsonObject[] = [];
  for (const cell of raw.cells) {
    if (!object(cell) || !id(cell.id) || cellIds.has(cell.id) || !id(cell.moduleId)
      || !Number.isFinite(cell.x) || !Number.isFinite(cell.y) || ![0, 90, 180, 270].includes(Number(cell.rot))) return false;
    cellIds.add(cell.id);
    cells.push({ ...cell });
  }
  if (!matchComboSubset(cells.map((cell) => normalizeCompartmentCode(String(cell.moduleId))), modules)) return false;
  if (!Array.isArray(raw.accessories) || raw.accessories.length > 200) return false;
  const pieceIds = new Set<string>();
  const accessories: JsonObject[] = [];
  for (const piece of raw.accessories) {
    if (!object(piece) || !id(piece.id) || pieceIds.has(piece.id) || !id(piece.modelId)
      || !id(piece.cellId) || !cellIds.has(piece.cellId) || !Number.isSafeInteger(piece.slot) || Number(piece.slot) < 0) return false;
    pieceIds.add(piece.id);
    accessories.push({ ...piece });
  }
  if (raw.depth !== undefined && (typeof raw.depth !== 'string' || !raw.depth.trim())) return false;
  return { cells, accessories, ...(typeof raw.depth === 'string' ? { depth: raw.depth } : {}) };
}
