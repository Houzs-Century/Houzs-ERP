/* ----------------------------------------------------------------------------
   so-after-do-client — the SO editor's side of shared/so-after-do-edit.ts
   (DEV-32): when the "Edit SO after DO" mode is on, which fields and lines it
   reopens, and what each save request carries so the server takes the after-DO
   road. The server re-checks every one of these; this only decides what the
   screen offers.
   -------------------------------------------------------------------------- */

import { LOCKED_STATUSES, soItemFrozen } from './so-detail-gates';
import {
  SO_EDIT_AFTER_DO_PERMISSION, afterDoHeaderRefusal, afterDoLineAllowed, type AfterDoTarget,
} from '../../shared/so-after-do-edit';

export type AfterDoHeader = {
  status?: string | null;
  after_do_targets?: AfterDoTarget[] | null;
  after_do_invoiced?: boolean | null;
};

export type AfterDoMode = {
  /** The permission holds, the order has an open DO, and (on a SHIPPED+ order) Override is on. */
  on: boolean;
  /** The customer details may change too: no DO of the order is invoiced or returned. */
  headerOpen: boolean;
  targets: AfterDoTarget[];
  openTargets: AfterDoTarget[];
};

export function soAfterDoMode(
  header: AfterDoHeader,
  p: { can: (key: string) => boolean; override: boolean; migrated: boolean },
): AfterDoMode {
  const targets = header.after_do_targets ?? [];
  const openTargets = targets.filter((t) => !t.locked);
  const statusLocked = LOCKED_STATUSES.includes(String(header.status ?? '').toUpperCase());
  const on = p.can(SO_EDIT_AFTER_DO_PERMISSION) && !p.migrated && header.after_do_invoiced !== true
    && openTargets.length > 0 && (p.override || !statusLocked);
  return { on, headerOpen: on && afterDoHeaderRefusal(targets, false) === null, targets, openTargets };
}

/** A saved line the mode reopens: a DO already carries it, and it is a charge. */
export function afterDoEditableLine(
  mode: AfterDoMode,
  item: { downstream_frozen?: unknown; item_code?: string | null; item_group?: string | null },
): boolean {
  return mode.on && soItemFrozen(item) && afterDoLineAllowed({ itemCode: item.item_code ?? null, itemGroup: item.item_group ?? null });
}

/** What the page knows at Save time. `chargeAdds` = new lines go through the
 *  after-DO road (the order would otherwise refuse them). */
export type AfterDoSave = { mode: AfterDoMode; lineIds: ReadonlySet<string>; chargeAdds: boolean; targetId: string | null };

export const afterDoHeaderFields = (s: AfterDoSave | null, patch: object): { afterDo?: true } =>
  s?.mode.headerOpen && Object.keys(patch).length > 0 ? { afterDo: true } : {};

export const afterDoEditFields = (s: AfterDoSave | null, itemId: string): { afterDo?: true } =>
  s?.lineIds.has(itemId) ? { afterDo: true } : {};

export const afterDoAddFields = (s: AfterDoSave | null): { afterDo?: true; targetDoId?: string } =>
  s?.chargeAdds ? { afterDo: true, ...(s.targetId ? { targetDoId: s.targetId } : {}) } : {};

/** The SO saved but a DO copy did not: say which DO, so nobody believes both agree. */
export function afterDoCopyProblem(result: unknown): string | null {
  const failed = (result as { doCopyFailed?: unknown } | null)?.doCopyFailed;
  if (!Array.isArray(failed) || failed.length === 0) return null;
  return `The Sales Order saved, but ${failed.join(', ')} was not updated. Open the Delivery Order and change it there too.`;
}
