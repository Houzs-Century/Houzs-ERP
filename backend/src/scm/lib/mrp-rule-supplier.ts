// ----------------------------------------------------------------------------
// mrp-rule-supplier — the supplier MRP pre-selects for a shortage line when the
// line's CONTENT, not its SKU, decides who can make it (HC-0128, Sim 2026-10-20):
// a Hydraulic bedframe and any NB-series fabric are only supplied by
// 400-N002 NB FURNITURE, while the bedframe SKUs' main supplier is HOOKKA.
// computeMrp then carries the choice to the SO's other bedframes, so one order
// never mixes two makers' bedframes.
//
// Only a default: the rule fires when NB is already bound to the SKU (so the PO
// prices from that binding — an unbound pick falls back to the main supplier in
// convertSosToPosCore), and the purchaser can still change the dropdown.
// ----------------------------------------------------------------------------

import { fabricCodeOf } from './fabric-supplier-code';

export const NB_SUPPLIER_CODE = '400-N002';
export const NB_FABRIC_SERIES = 'NB';

const HYDRAULIC = /hydraulic/i;

const specialText = (s: unknown): string => {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') {
    const o = s as { code?: unknown; label?: unknown };
    return `${typeof o.code === 'string' ? o.code : ''} ${typeof o.label === 'string' ? o.label : ''}`;
  }
  return '';
};

/* Hydraulic is matched in the picked specials AND the free-text add-on note:
   Sim's own example (HC-SO-2610-161) only says "with hydraulic" in
   extraAddonNote. `special` is the legacy key. The AutoCount-recorded specials
   key is left out on purpose: a guard test keeps it to display surfaces, and a
   supplier pick decides the PO's price. */
const hasHydraulic = (v: Record<string, unknown>): boolean => {
  for (const key of ['specials', 'special']) {
    const arr = v[key];
    if (Array.isArray(arr) && arr.some((s) => HYDRAULIC.test(specialText(s)))) return true;
    if (typeof arr === 'string' && HYDRAULIC.test(arr)) return true;
  }
  const note = v.extraAddonNote;
  return typeof note === 'string' && HYDRAULIC.test(note);
};

/* nbFabricCodes: upper-cased fabric_code of every Fabric Converter row whose
   series is NB. */
export const needsNbSupplier = (variants: unknown, nbFabricCodes: ReadonlySet<string>): boolean => {
  if (!variants || typeof variants !== 'object') return false;
  const v = variants as Record<string, unknown>;
  if (hasHydraulic(v)) return true;
  const fc = fabricCodeOf(v).toUpperCase();
  return fc !== '' && nbFabricCodes.has(fc);
};
