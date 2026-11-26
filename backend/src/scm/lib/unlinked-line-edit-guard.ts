
import {
  itemCodeKey,
  readParentCodes,
  unlinkedCheckUnavailableResponse,
  type ParentCodes,
  type UnlinkedScan,
} from './do-unlinked-so-lines';
import { poMaterialCodesOf } from './grn-unlinked-po-lines';
import { doItemCodesOf, grnMaterialCodesOf } from './return-unlinked-lines';
import { doRemainingByItemId } from './do-line-remaining';
import { scopeToCompanyId } from './companyScope';

export { unlinkedCheckUnavailableResponse } from './do-unlinked-so-lines';

/**
 * The item codes on a Delivery Order that STILL HAVE PENDING QTY.
 *
 * The Sales Invoice chain's rule is deliberately narrower than the other three:
 * the owner ruled that a Sales Invoice MAY carry direct/standalone lines, so
 * only a line shadowing a DO line with remaining > 0 is a double-invoice. A DO
 * line already fully invoiced is left alone. Shared with the SI insert path so
 * both ends of that chain speak one definition of "shadow".
 *
 * FAIL-CLOSED, BOTH HALVES. The DO-lines read decides which codes are on the DO
 * at all; the remaining computation decides which of those still have qty open.
 * Until the do-line-remaining refactor landed, only the first was reported — a
 * failure in the second read as remaining 0, i.e. "not pending", i.e. ALLOWED,
 * which is the whole exploit this guard exists to stop, reachable by nothing
 * more than a five-second database blip. Both now return `ok: false`, which
 * unlinkedScanRefusal turns into a refusal instead of "no offenders".
 */
export async function doPendingItemCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  deliveryOrderId: string | null | undefined,
): Promise<ParentCodes> {
  const id = String(deliveryOrderId ?? '').trim();
  if (!id) return { ok: true, codes: new Set() };
  const { data, error } = await sb
    .from('delivery_order_items')
    .select('id, item_code')
    .eq('delivery_order_id', id);
  if (error) return { ok: false, reason: error.message ?? 'delivery_order_items lookup failed' };
  const rows = (data ?? []) as Array<{ id: string; item_code: string | null }>;
  if (rows.length === 0) return { ok: true, codes: new Set() };
  /* 'delivered' — UNCHANGED from what this shadow guard has always measured.
     It asks whether a parent DO line still has open quantity, which is a stock
     question, and the owner's 2026-08-20 ruling was about invoicing. Stated so
     the next reader sees a decision rather than an oversight. */
  const remaining = await doRemainingByItemId(sb, rows.map((r) => r.id), 'delivered');
  if (!remaining.ok) return { ok: false, reason: `remaining unreadable: ${remaining.reason}` };
  const out = new Set<string>();
  for (const r of rows) {
    if ((remaining.remaining.get(r.id) ?? 0) <= 0) continue;
    const k = itemCodeKey(r.item_code);
    if (k) out.add(k);
  }
  return { ok: true, codes: out };
}

/**
 * The 409 body an insert-path scan calls for, or null to proceed.
 *
 * Every insert call site has to answer the SAME two questions in the same order
 * — could the parent be read, and did the scan find anything — and getting the
 * order wrong (or dropping the first) is the fail-open this whole change is
 * about. One helper means one answer: `ok: false` can never fall through to
 * "no offenders" at a call site that forgot to check it.
 */
export function unlinkedScanRefusal<T>(
  scan: UnlinkedScan<T>,
  body: (offenders: T[]) => unknown,
): unknown | null {
  if (!scan.ok) return unlinkedCheckUnavailableResponse(scan.reason);
  return scan.offenders.length > 0 ? body(scan.offenders) : null;
}

/**
 * The Sales Invoice INSERT-path shadow check, as a refusal body or null.
 *
 * Lived in sales-invoices.ts until 2026-08-17, where it read the DO itself and
 * dropped the error. It sits here now so both ends of that chain — the two
 * insert paths and the line PATCH — cannot drift apart on what "shadow" means,
 * and so the read fails closed in one place.
 *
 * The narrow rule is the owner's: a Sales Invoice MAY carry direct/standalone
 * lines, so only a line shadowing a DO line with remaining > 0 is refused. One
 * whose DO line is already fully invoiced is left alone.
 */
export async function siShadowRefusal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  doId: string,
  lines: Array<Record<string, unknown>>,
  message: (codes: string[]) => string,
): Promise<UnlinkedEditRefusal | null> {
  const unlinked = lines.filter((l) => !l.doItemId && l.itemCode);
  if (unlinked.length === 0) return null;
  const pending = await doPendingItemCodesOf(sb, doId);
  if (!pending.ok) return unlinkedCheckUnavailableResponse(pending.reason);
  const offenders = [...new Set(unlinked
    .filter((l) => pending.codes.has(String(l.itemCode).trim().toUpperCase()))
    .map((l) => String(l.itemCode)))];
  if (offenders.length === 0) return null;
  return { error: 'unlinked_do_line', message: message(offenders), itemCodes: offenders };
}

/**
 * Every item_code on the source Consignment Note's lines — the parent of a
 * Consignment Delivery Return (`consignment_delivery_returns.consignment_do_id`
 * names the note; a linked return line carries `consignment_do_item_id`). Its
 * lines live in `consignment_delivery_order_items`, keyed by
 * `consignment_delivery_order_id`. Same fail-closed ParentCodes as its four
 * siblings: `ok: false` is refused, never read as "the note carries nothing".
 */
export function cnItemCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  consignmentDoId: string | null | undefined,
): Promise<ParentCodes> {
  return readParentCodes(sb, {
    table: 'consignment_delivery_order_items',
    select: 'item_code',
    codeColumn: 'item_code',
    parentColumn: 'consignment_delivery_order_id',
    parentId: consignmentDoId,
  });
}

/**
 * Every item_code on the source PC Receive's lines — the parent of a Purchase
 * Consignment Return (`purchase_consignment_returns.pc_receive_id` names the
 * receive; a linked return line carries `pc_receive_item_id`). Its lines live in
 * `purchase_consignment_receive_items`, keyed by `pc_receive_id` (the column was
 * `material_code` until mig 0307 unified it to `item_code`).
 */
export function pcReceiveItemCodesOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  pcReceiveId: string | null | undefined,
): Promise<ParentCodes> {
  return readParentCodes(sb, {
    table: 'purchase_consignment_receive_items',
    select: 'item_code',
    codeColumn: 'item_code',
    parentColumn: 'pc_receive_id',
    parentId: pcReceiveId,
  });
}

export type UnlinkedEditChain =
  | 'grn'
  | 'purchase-return'
  | 'delivery-return'
  | 'sales-invoice'
  | 'consignment-return'
  | 'purchase-consignment-return';

type ChainSpec = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  codesOf: (sb: any, parentId: string) => Promise<ParentCodes>;
  parentNoun: string;
  picker: string;
  consequence: string;
};

const CHAINS: Record<UnlinkedEditChain, ChainSpec> = {
  grn: {
    codesOf: poMaterialCodesOf,
    parentNoun: 'Purchase Order',
    picker: 'Pick the material from the Purchase Order',
    consequence:
      'an unlinked line still takes the stock in but ticks nothing off the order, '
      + 'so the same delivery can be received again',
  },
  'purchase-return': {
    codesOf: grnMaterialCodesOf,
    parentNoun: 'Goods Receipt',
    picker: 'Pick the material from the Goods Receipt',
    consequence:
      'an unlinked line still sends the stock out but counts against no receipt line, '
      + 'so the same goods can be returned again',
  },
  'delivery-return': {
    codesOf: doItemCodesOf,
    parentNoun: 'Delivery Order',
    picker: 'Pick the item from the Delivery Order',
    consequence:
      'an unlinked line still brings the stock back in but counts against no delivery line, '
      + 'so the same goods can be returned again',
  },
  'sales-invoice': {
    codesOf: doPendingItemCodesOf,
    parentNoun: 'Delivery Order',
    picker: 'Add it through "Add from Delivery Order"',
    consequence:
      'an unlinked line still bills the customer but takes nothing off the delivery, '
      + 'so the same delivered goods can be invoiced again',
  },
  'consignment-return': {
    codesOf: cnItemCodesOf,
    parentNoun: 'Consignment Note',
    picker: 'Pick the item from the Consignment Note',
    consequence:
      'an unlinked line still brings the stock back in but counts against no note line, '
      + 'so the same goods can be returned again',
  },
  'purchase-consignment-return': {
    codesOf: pcReceiveItemCodesOf,
    parentNoun: 'PC Receive',
    picker: 'Pick the material from the PC Receive',
    consequence:
      'an unlinked line still sends the stock out but counts against no receive line, '
      + 'so the same goods can be returned again',
  },
};

export type UnlinkedEditInput = {
  parentId?: string | null | undefined;
  parent?: {
    table: string;
    column: string;
    id: string;
    companyId: number;
  };
  storedLink: string | null | undefined;
  storedCode: string | null | undefined;
  patchCode: unknown;
};

/** The 409 body for a re-point, or the one for "could not check". */
export type UnlinkedEditRefusal = {
  error: string;
  message: string;
  itemCode?: string;
  itemCodes?: string[];
  parentNoun?: string;
};

/**
 * ONE call per handler. Returns the 409 body to send, or null to proceed.
 *
 * Deliberately NOT a boolean "already converted" flag (owner ruling, 2026-08-17):
 * it asks only whether THIS edit re-points an unlinked line at the parent's own
 * goods. A parent that has legitimately been received or shipped in batches is
 * untouched — nothing here counts how many times anything was converted.
 */
export async function unlinkedEditRefusal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  chain: UnlinkedEditChain,
  input: UnlinkedEditInput,
): Promise<UnlinkedEditRefusal | null> {
  if (input.storedLink) return null;
  if (input.patchCode === undefined) return null;

  const effective = itemCodeKey(input.patchCode as string | null | undefined);
  if (!effective) return null;
  const stored = itemCodeKey(input.storedCode);
  if (effective === stored) return null;

  const spec = CHAINS[chain];

  let parentId = String(input.parentId ?? '').trim();
  if (!parentId && input.parent) {
    const p = input.parent;
    const { data, error } = await scopeToCompanyId(
      sb.from(p.table).select(p.column).eq('id', p.id), p.companyId,
    ).maybeSingle();
    if (error) {
      return {
        error: 'unlinked_check_failed',
        message:
          `Could not read this document's source ${spec.parentNoun} to check the line, so the `
          + `edit was not saved — try again (${error.message ?? 'lookup failed'}).`,
      };
    }
    parentId = String((data as Record<string, unknown> | null)?.[p.column] ?? '').trim();
  }
  if (!parentId) return null;
  const codes = await spec.codesOf(sb, parentId);
  if (!codes.ok) {
    return {
      error: 'unlinked_check_failed',
      message:
        `Could not read the source ${spec.parentNoun} to check this line, so the edit was not `
        + `saved — try again (${codes.reason}).`,
    };
  }
  if (stored && codes.codes.has(stored)) return null;
  if (!codes.codes.has(effective)) return null;

  const shown = String(input.patchCode ?? '').trim();
  return {
    error: 'unlinked_line_repoint',
    message:
      `This line is not linked to the ${spec.parentNoun} this document names, but ${shown} is on it. `
      + `${spec.picker} instead of re-typing the code on an unlinked line — ${spec.consequence}.`,
    itemCode: shown,
    parentNoun: spec.parentNoun,
  };
}
