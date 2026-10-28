/* so-line-freeze.ts — WHICH Sales Order lines are FROZEN because a later document
 * already carries them, in ONE place the server and both screens read.
 *
 * OWNER RULING 2026-09-15, verbatim:
 *   「如果已经送货了的，你就 remain 着，可能要放灰色之类的，设置成不可以被 edit」
 *   「当它可以 proceed 的时候，我那些已经送货了的就会变灰色、不能动到。这样子我更改任何
 *    东西（包括 delivery date，比如我在表头填写 delivery date，下面行不是会跟着变嘛），
 *    它就不会再影响到我们已经送货了的单，直接 freeze 起来。它为什么可以 edit 的原理，是
 *    因为它还有东西可以被 convert」
 * Shown and not objected to on the same day: a partly delivered line is fully
 * locked; a line on a DRAFT delivery order is locked; a line on a sales invoice
 * is locked.
 *
 * THIS REPLACES the order-wide rule for LINE writes. Until 2026-09-15 one live
 * Delivery Order or Sales Invoice anywhere on the order refused every line add,
 * edit and delete (soHasDownstream), so the undelivered half of a partly
 * delivered order could not be touched at all.
 *
 * THE RULE.
 *   1. A line is FROZEN when a delivery order line names it and that delivery
 *      order is not CANCELLED (a DRAFT counts), or when a sales invoice line
 *      names it and that invoice is not CANCELLED.
 *   2. Partly delivered is WHOLLY frozen: ordered 3, delivered 1 freezes all 3.
 *   3. FAIL CLOSED on a line nobody can place. A live delivery order or invoice
 *      raised against this order that carries a line naming NO sales-order line
 *      (and, on an invoice, no delivery-order line either) cannot be tied to
 *      the line it shipped, so EVERY line of the order is treated as frozen —
 *      exactly the old order-wide lock.
 *   4. The ORDER stays open while at least one live line is not frozen: it
 *      still has something to convert. An order with a live downstream document
 *      and no unfrozen line is FULLY FROZEN and behaves as the old locked order
 *      (no line added, no line changed).
 *
 * WHAT THIS DOES NOT CHANGE. Cancelling an order with a live delivery order or
 * invoice is still refused (soHasDownstream). The header identity fields a
 * delivery order snapshots (shared/so-identity-lock.ts) still freeze on the
 * first live child. The processing-date lock is untouched.
 *
 * BYTE-IDENTICAL COPIES: backend/src/scm/shared/so-line-freeze.ts (the SO line
 * routes, the header date cascade, the detail payload) and
 * frontend/src/vendor/shared/so-line-freeze.ts (the desktop editor and the phone
 * editor). Refereed by frontend/src/vendor/shared/so-line-freeze.canonical.test.ts.
 * The header date cascade inside scm.apply_so_header_cas states rules 1 and 3
 * in SQL (migration 20260915T1200_scm_so_header_cas_skip_frozen_lines.sql); a
 * change here is a change there. Edit all or none. */

/** A downstream line as the server read it. `status` is its PARENT document's. */
export type SoFreezeDownstreamLine = {
  kind: 'DO' | 'SI';
  so_item_id: string | null;
  /** Sales invoice lines only: the delivery-order line it billed, if any. */
  do_item_id?: string | null;
  status: string | null;
};

export type SoLineFreeze = {
  /** Sales-order line ids a live delivery order or invoice line names. */
  frozenLineIds: ReadonlySet<string>;
  /** Rule 3: a live downstream line names no line, so every line is frozen. */
  unlinked: boolean;
  /** Any live delivery order / invoice on this order (by header or by line). */
  hasLiveDownstream: boolean;
};

const live = (status: string | null | undefined): boolean =>
  String(status ?? '').trim().toUpperCase() !== 'CANCELLED';

/** Fold the downstream lines (every line naming one of this order's lines, plus
 *  every line of a document raised against this order) into the verdict.
 *  `liveDocumentCount` is the number of live delivery orders + invoices whose
 *  header points at this order — a document with no lines yet still counts. */
export function soLineFreezeFrom(
  lines: ReadonlyArray<SoFreezeDownstreamLine>,
  liveDocumentCount: number,
): SoLineFreeze {
  const frozen = new Set<string>();
  let unlinked = false;
  for (const l of lines) {
    if (!live(l.status)) continue;
    if (l.so_item_id) frozen.add(l.so_item_id);
    else if (l.kind === 'DO' || !l.do_item_id) unlinked = true;
  }
  return { frozenLineIds: frozen, unlinked, hasLiveDownstream: liveDocumentCount > 0 || frozen.size > 0 || unlinked };
}

/** Rules 1-3 for one line. */
export function soLineFrozen(freeze: SoLineFreeze, lineId: string): boolean {
  return freeze.unlinked || freeze.frozenLineIds.has(lineId);
}

/** Rule 4: nothing left to convert. `liveLineIds` are the order's non-cancelled
 *  lines. An order with no live downstream document is never fully frozen. */
export function soOrderFullyFrozen(freeze: SoLineFreeze, liveLineIds: ReadonlyArray<string>): boolean {
  if (!freeze.hasLiveDownstream) return false;
  return liveLineIds.every((id) => soLineFrozen(freeze, id));
}

/** The line-write refusal. 409, like every other SO lock. */
export const SO_LINE_FROZEN_REFUSAL = {
  error: 'so_line_frozen',
  message: 'This line is already on a Delivery Order or Sales Invoice, so it is locked. Cancel that document first to change it.',
} as const;

/** A fully frozen order refuses a NEW line with the code the old order-wide
 *  lock used, so a client that already handles it keeps working. */
export const SO_FULLY_FROZEN_REFUSAL = {
  error: 'so_has_downstream',
  message: 'Everything on this Sales Order is already on a Delivery Order or Sales Invoice — cancel one of them first to change it.',
} as const;

/* ── What the SCREENS read ──────────────────────────────────────────────────
   The browser cannot see delivery order lines, so the server stamps the verdict
   on the detail payload: `downstream_frozen` on each line and
   `downstream_fully_frozen` on the header. */

/** A line the editor must render greyed and read-only. */
export function soItemFrozen(item: { downstream_frozen?: unknown } | null | undefined): boolean {
  return item?.downstream_frozen === true;
}

/** The order-level hard lock the screens apply. A payload without the new flag
 *  (a cached pre-2026-09-15 response) falls back to `has_children`, which is the
 *  STRICTER answer — the old order-wide lock. */
export function soDownstreamHardLocked(
  header: { has_children?: unknown; downstream_fully_frozen?: unknown } | null | undefined,
): boolean {
  if (typeof header?.downstream_fully_frozen === 'boolean') return header.downstream_fully_frozen;
  return header?.has_children === true;
}
