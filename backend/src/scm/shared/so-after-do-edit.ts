/* so-after-do-edit.ts — what a Sales Order still lets Logistics change once a
 * Delivery Order carries it, in ONE place the server and both screens read.
 *
 * DEV-32 (Syu, 2026-10-01): "Users with permission (ie Logistics) to edit the SO
 * even after pick DO, then the changes also update into the DO" — for charge
 * lines (transport, storage, misc) and the customer details. Her three answers:
 * charge lines only; the line goes onto the DO by itself (the user picks the DO
 * when there is more than one); a DO with an invoice or a return stays locked.
 *
 * THE RULE. A caller holding `scm.so.edit_after_do`, after pressing Override, may
 *   1. change the customer details in SO_AFTER_DO_CUSTOMER_COLS; the saved values
 *      are copied onto every live Delivery Order of the order;
 *   2. add a SERVICE line and put it on ONE live Delivery Order;
 *   3. edit a SERVICE line a Delivery Order already carries; the DO line follows.
 * Never through a Delivery Order that has a live Sales Invoice or Delivery Return
 * (`locked` below), and never on an order invoiced without a DO.
 *
 * Everyone else keeps so-identity-lock.ts and so-line-freeze.ts exactly as they
 * were. State is NOT unlockable: it picks the warehouse the goods left from.
 *
 * BYTE-IDENTICAL COPIES: backend/src/scm/shared/so-after-do-edit.ts (the SO
 * routes) and frontend/src/vendor/shared/so-after-do-edit.ts (desktop + phone).
 * Refereed by frontend/src/vendor/shared/so-line-freeze.canonical.test.ts. */

import { isServiceLine } from './service-sku';

export const SO_EDIT_AFTER_DO_PERMISSION = 'scm.so.edit_after_do';

/** SO header column -> the Delivery Order column it is copied into (null = the
 *  DO has no such column; the SO change still saves). address3/4 fold into the
 *  DO's address2 the way the DO create does. */
export const SO_AFTER_DO_CUSTOMER_COLS: Readonly<Record<string, string | null>> = {
  debtor_name: 'debtor_name',
  customer_id: null,
  phone: 'phone',
  email: 'email',
  address1: 'address1',
  address2: 'address2',
  address3: 'address2',
  address4: 'address2',
  city: 'city',
  postcode: 'postcode',
  ship_to_address: null,
  bill_to_address: null,
  install_to_address: null,
  customer_type: 'customer_type',
  building_type: 'building_type',
  emergency_contact_name: 'emergency_contact_name',
  emergency_contact_phone: 'emergency_contact_phone',
  emergency_contact_relationship: 'emergency_contact_relationship',
};

/** A live Delivery Order of the order, as the detail payload carries it.
 *  `locked` = it has a live Sales Invoice or Delivery Return. */
export type AfterDoTarget = { id: string; do_number: string | null; status: string | null; locked: boolean };

export type AfterDoRefusal = { error: string; message: string; [k: string]: unknown };

export const AFTER_DO_FORBIDDEN: AfterDoRefusal = {
  error: 'forbidden_edit_after_do',
  message: 'Changing a Sales Order after its Delivery Order needs the "Edit SO after DO" permission.',
};

export const AFTER_DO_SERVICE_ONLY: AfterDoRefusal = {
  error: 'after_do_service_only',
  message: 'After the Delivery Order, only charge lines (transport, storage, misc) can be added or changed here.',
};

export const AFTER_DO_INVOICED: AfterDoRefusal = {
  error: 'after_do_invoiced',
  message: 'This order already has a Sales Invoice. Cancel the invoice first to change it.',
};

export const AFTER_DO_NO_DO: AfterDoRefusal = {
  error: 'after_do_no_do',
  message: 'This order has no open Delivery Order to put the charge on.',
};

export function afterDoTargetLockedRefusal(doNumbers: ReadonlyArray<string>): AfterDoRefusal {
  return {
    error: 'after_do_target_locked',
    message: `${doNumbers.join(', ')} already has a Sales Invoice or Delivery Return. Cancel it first to change this order.`,
    doNumbers: [...doNumbers],
  };
}

export function afterDoFieldsRefusal(cols: ReadonlyArray<string>): AfterDoRefusal {
  return {
    error: 'so_identity_locked',
    message: `After the Delivery Order only the customer name, phone, email, address and contact can change (not: ${cols.join(', ')}).`,
    lockedFields: [...cols],
  };
}

/** The locked columns a change touches that the permission does NOT unlock. */
export function afterDoBlockedCols(changedLocked: ReadonlyArray<string>): string[] {
  return changedLocked.filter((col) => !(col in SO_AFTER_DO_CUSTOMER_COLS));
}

/** The DO's address2, from the SO row the same way the DO create builds it. */
export function soDoAddress2(so: Record<string, unknown>): string | null {
  const a2 = so.address2 as string | null | undefined;
  if (a2 != null) return a2;
  return [so.address3, so.address4].filter(Boolean).join(', ') || null;
}

/** The DO header columns (DB names) carrying the SAVED order's customer details,
 *  for the SO columns this change touched. */
export function doHeaderPatchFromSo(so: Record<string, unknown>, changedCols: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of changedCols) {
    const target = SO_AFTER_DO_CUSTOMER_COLS[col];
    if (!target) continue;
    out[target] = target === 'address2' ? soDoAddress2(so) : (so[col] ?? null);
  }
  return out;
}

/** Whether the customer details may be copied onto these DOs: every one open. */
export function afterDoHeaderRefusal(targets: ReadonlyArray<AfterDoTarget>, invoicedWithoutDo: boolean): AfterDoRefusal | null {
  if (invoicedWithoutDo) return AFTER_DO_INVOICED;
  const locked = targets.filter((t) => t.locked).map((t) => t.do_number ?? t.id);
  return locked.length > 0 ? afterDoTargetLockedRefusal(locked) : null;
}

export type AfterDoPick = { ok: true; target: AfterDoTarget } | { ok: false; refusal: AfterDoRefusal };

/** Which DO a new charge line goes on. One open DO is picked by itself; with
 *  several, the caller must name one. */
export function pickAfterDoTarget(targets: ReadonlyArray<AfterDoTarget>, requestedId: string | null): AfterDoPick {
  if (requestedId) {
    const t = targets.find((x) => x.id === requestedId);
    if (!t) return { ok: false, refusal: AFTER_DO_NO_DO };
    return t.locked ? { ok: false, refusal: afterDoTargetLockedRefusal([t.do_number ?? t.id]) } : { ok: true, target: t };
  }
  const open = targets.filter((t) => !t.locked);
  if (open.length === 1) return { ok: true, target: open[0] };
  if (open.length > 1) {
    return {
      ok: false,
      refusal: {
        error: 'after_do_pick_do',
        message: 'This order has more than one Delivery Order. Pick the one the charge goes on.',
        dos: open.map((t) => ({ id: t.id, do_number: t.do_number })),
      },
    };
  }
  return { ok: false, refusal: targets.length > 0 ? afterDoTargetLockedRefusal(targets.map((t) => t.do_number ?? t.id)) : AFTER_DO_NO_DO };
}

/** A charge line: the only kind the permission adds or edits after the DO. */
export function afterDoLineAllowed(line: { itemCode?: string | null; itemGroup?: string | null; category?: string | null }): boolean {
  return isServiceLine({ itemCode: line.itemCode ?? null, itemGroup: line.itemGroup ?? null, category: line.category ?? null });
}
