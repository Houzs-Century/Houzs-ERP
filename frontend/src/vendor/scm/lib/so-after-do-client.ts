
import { LOCKED_STATUSES, soDownstreamHardLocked, soItemFrozen } from './so-detail-gates';
import {
  SO_EDIT_AFTER_DO_PERMISSION, SO_EDIT_PRICE_AFTER_DO_PERMISSION, SO_EDIT_LINES_AFTER_DO_PERMISSION,
  afterDoHeaderRefusal, afterDoLineAllowed, type AfterDoTarget,
} from '../../shared/so-after-do-edit';

export type AfterDoHeader = {
  status?: string | null;
  after_do_targets?: AfterDoTarget[] | null;
  after_do_invoiced?: boolean | null;
};

export type AfterDoMode = {
  on: boolean;
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

/** DEV-70 — `scm.so.edit_price_after_do` may re-price a line a DO carries. No
 *  Override needed: the door is one line's price dialog, not the whole order. */
export function soPriceAfterDoOn(
  header: AfterDoHeader,
  p: { can: (key: string) => boolean; migrated: boolean },
): boolean {
  return p.can(SO_EDIT_PRICE_AFTER_DO_PERMISSION) && !p.migrated && header.after_do_invoiced !== true
    && (header.after_do_targets ?? []).some((t) => !t.returned);
}

/** Owner 2026-11-21 — `scm.so.edit_lines_after_do` (super admin) reopens the
 *  QUANTITY and SPECIFICATION of a PRODUCT line a DO carries. No Override: the
 *  door is the frozen line itself, re-opened inline in the editor. A DO with a
 *  live Delivery Return stays shut (the server refuses it too). */
export function soLinesAfterDoOn(
  header: AfterDoHeader,
  p: { can: (key: string) => boolean; migrated: boolean },
): boolean {
  return p.can(SO_EDIT_LINES_AFTER_DO_PERMISSION) && !p.migrated
    && (header.after_do_targets ?? []).some((t) => !t.returned);
}

/** A saved line the mode reopens: a DO already carries it, and it is a charge. */
export function afterDoEditableLine(
  mode: AfterDoMode,
  item: { downstream_frozen?: unknown; item_code?: string | null; item_group?: string | null },
): boolean {
  return mode.on && soItemFrozen(item) && afterDoLineAllowed({ itemCode: item.item_code ?? null, itemGroup: item.item_group ?? null });
}

/** The super-admin counterpart: a frozen PRODUCT line (never a charge line —
 *  those are the DEV-32 door) re-opened for a qty / spec change. */
export function afterDoProductLineEditable(
  linesOn: boolean,
  item: { downstream_frozen?: unknown; item_code?: string | null; item_group?: string | null },
): boolean {
  return linesOn && soItemFrozen(item) && !afterDoLineAllowed({ itemCode: item.item_code ?? null, itemGroup: item.item_group ?? null });
}

/** Owner 2026-11-21 — a super admin may also edit or remove a NON-frozen
 *  SERVICE / charge line stuck on a locked / completed order: it is on no
 *  Delivery Order, so there is nothing downstream to follow — a plain SO edit /
 *  delete the server lets past the processing-date lock. */
export function afterDoFeeLineEditable(
  linesOn: boolean,
  item: { downstream_frozen?: unknown; item_code?: string | null; item_group?: string | null },
): boolean {
  return linesOn && !soItemFrozen(item) && afterDoLineAllowed({ itemCode: item.item_code ?? null, itemGroup: item.item_group ?? null });
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

/** The phone detail's Edit button on a locked order (DEV-32): it opens when the
 *  editor's Override would unlock something — a status lock with no order-wide
 *  DO/SI freeze (desktop isSoLocked), or the after-DO mode. A migrated order
 *  never opens. The editor still decides what each field and line allows. */
export function soEditOpensOnOverride(
  header: AfterDoHeader & { downstream_fully_frozen?: boolean | null; has_children?: boolean | null },
  p: { can: (key: string) => boolean; migrated: boolean },
): boolean {
  if (p.migrated) return false;
  const statusOnly = LOCKED_STATUSES.includes(String(header.status ?? '').toUpperCase()) && !soDownstreamHardLocked(header);
  return statusOnly || soAfterDoMode(header, { can: p.can, override: true, migrated: false }).on
    || soLinesAfterDoOn(header, { can: p.can, migrated: false });
}
