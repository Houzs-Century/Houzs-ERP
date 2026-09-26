// ----------------------------------------------------------------------------
// dispatch-cell — pure helpers for the Delivery Planning board's inline crew
// pickers (Driver / Lorry / Helper 1 / Helper 2), owner 2026-09-26.
//
// The board shows a crew member by NAME (the delivery_order_crew snapshot), not
// by id, so a picker has to (a) turn the master list into SearchCombo options,
// (b) preselect the row's current assignment by matching that name, and (c) keep
// an assignment whose master row is gone (deactivated / renamed) visible instead
// of blanking it. Crew writes go to the DO crew store, so the target is the
// order's LATEST live delivery order — null when none exists yet.
// ----------------------------------------------------------------------------

import type { ComboOption } from '../components/SearchCombo';

/** A crew slot whose current assignment is NOT (or no longer) in the active
 *  master list — shown as a selectable option so an existing pick never
 *  vanishes; choosing it again is a no-op the cell guards. */
export const KEEP_CURRENT = '__current__';

/** One master row reduced to what a picker needs: its id and the label the
 *  operator reads (driver/helper name, lorry plate). */
export type CrewMasterItem = { id: string; label: string; group?: string };

/** Options for a crew SearchCombo: a leading "— none —" (so a seat can be
 *  cleared), then the current off-list assignment when it is not in `items`,
 *  then the master rows in their given order. */
export function crewComboOptions(items: CrewMasterItem[], currentLabel: string | null): ComboOption[] {
  const out: ComboOption[] = [{ value: '', label: '— none —' }];
  const label = (currentLabel ?? '').trim();
  if (label && !items.some((it) => it.label === label)) out.push({ value: KEEP_CURRENT, label });
  for (const it of items) out.push({ value: it.id, label: it.label, group: it.group });
  return out;
}

/** The value to preselect for the current assignment: the matched master id, or
 *  KEEP_CURRENT when the name is off-list, or '' when nothing is assigned. */
export function crewComboValue(items: CrewMasterItem[], currentLabel: string | null): string {
  const label = (currentLabel ?? '').trim();
  if (!label) return '';
  return items.find((it) => it.label === label)?.id ?? KEEP_CURRENT;
}

/** The delivery order whose crew the board shows for this row (the latest live
 *  DO) — the target of a crew write. null when the order has no DO yet, in which
 *  case crew cannot be saved and the caller must prompt to create one. */
export function latestDoId(deliveryOrders: ReadonlyArray<{ id: string }>): string | null {
  return deliveryOrders.length > 0 ? deliveryOrders[deliveryOrders.length - 1]!.id : null;
}
