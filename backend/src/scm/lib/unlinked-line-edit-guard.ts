// ----------------------------------------------------------------------------
// unlinked-line-edit-guard — the same back door, reached by EDITING instead of
// inserting.
//
// WHAT THE INSERT GUARDS ALREADY DO. Five chains refuse an unlinked line whose
// code is on the parent the document names (do-unlinked-so-lines,
// grn-unlinked-po-lines, return-unlinked-lines, and the from-DO check inside
// sales-invoices). The rule is narrow on purpose: a service, freight or
// genuinely ad-hoc line whose code is on NO covered parent still passes.
//
// WHAT NONE OF THEM DID. Every one of those guards runs on the INSERT. The line
// PATCH handlers map a code field straight into the update with no guard at all,
// so the refusal is two saves away from being pointless:
//
//   1. add a line whose material is NOT on the named parent   -> correctly allowed
//   2. PATCH that line's material code to one that IS on it   -> nothing looked
//
// The stored link column is still NULL after step 2, and NULL is what every cap
// and every recount keys on:
//
//   grns.ts            `if (poItemId && qtyReceived > prevQty)`  — cap skipped
//                      `recomputePoReceived(sb, [purchase_order_item_id])` — sums
//                      by the link, so the PO line still reads fully outstanding
//   purchase-returns   `if (grnItemId && delta !== 0)`           — cap skipped
//                      `adjustGrnReturnedQty` never called       — GRN line intact
//   sales-invoices     `if (it.qty !== undefined && prev.do_item_id && …)` — skipped
//
// So the parent is served again and the goods are billed or shipped twice. On
// the invoice chains the accounting side DOES move: revenue is re-posted and the
// document is re-enqueued to AutoCount.
//
// WHY THIS FILE EXISTS AT ALL, rather than the check being written into each of
// the four handlers. The finding that produced this work is that a rule written
// at N call sites ends up present at N-1 — the PI money guard was on 2 of 3
// write paths and 0 of 5 sibling edit paths, and nobody was careless: a route
// was added later and did not know the rule existed. Writing the same paragraph
// into four handlers would reproduce exactly that. The rule lives here once. The
// differences between the chains are ARGUMENTS — which parent column, which link
// column, which code field — declared once in CHAINS below.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//   header names no parent            -> nothing to bypass, allowed
//   the line's stored link is NOT NULL-> cap + recount already govern it, allowed
//   the patch does not touch the code -> not this edit's business, allowed
//   effective code == stored code     -> nothing moved, allowed
//   stored code was ALREADY on parent -> pre-existing state, NOT this actor's
//                                        doing, allowed (see below)
//   effective code is NOT on parent   -> still genuinely ad-hoc, allowed
//   effective code IS on parent       -> REFUSED: link it, or use the picker
//
// The effective code is `patch.code ?? stored.code` — the POST-edit value, which
// is the only value that can be wrong. Checking the patch alone would miss
// nothing here but would fire on a patch that never mentioned the code.
//
// WHY A LINE THAT WAS ALREADY BAD IS LEFT ALONE. Every one of these link columns
// is `ON DELETE SET NULL` (2990s-full-schema.sql:1656, 1662, 1739, 1754), so
// deleting a parent line ORPHANS its children: a perfectly legitimate line whose
// code is on the parent can arrive at NULL through no act of the operator's. A
// check must only fail on something the person in front of it could have done —
// refusing their qty correction because a link was cut elsewhere blames the
// wrong actor and fixes nothing. This guard fires on the TRANSITION
// (not-on-parent -> on-parent), which is the act the exploit needs and the only
// part the editor controls. The residual — an orphan's qty being raised — is
// recorded in BUG-HISTORY rather than papered over here.
//
// FAIL CLOSED. The parent-code read returns ParentCodes, and `ok: false` is
// refused, never read as "nothing on the parent". See readParentCodes.
// ----------------------------------------------------------------------------

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
 * FAIL-CLOSED SCOPE, stated honestly: the DO-lines read below is the load-bearing
 * one — it decides which codes are on the DO at all — and its failure is
 * reported. The remaining computation (doLineRemaining, via doRemainingByItemId)
 * is fail-open throughout and shared by many callers; a failure there reads as
 * remaining 0, i.e. "not pending", i.e. allowed. Closing that is a refactor of
 * do-line-remaining.ts with its own blast radius and is filed separately rather
 * than smuggled in here.
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
  const remaining = await doRemainingByItemId(sb, rows.map((r) => r.id));
  const out = new Set<string>();
  for (const r of rows) {
    if ((remaining.get(r.id) ?? 0) <= 0) continue;
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

export type UnlinkedEditChain =
  | 'grn'
  | 'purchase-return'
  | 'delivery-return'
  | 'sales-invoice';

type ChainSpec = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  codesOf: (sb: any, parentId: string) => Promise<ParentCodes>;
  /** What the parent document is called to an operator. */
  parentNoun: string;
  /** How the operator is meant to attach the line instead. */
  picker: string;
  /** What an unlinked line of this kind does that nothing counts. */
  consequence: string;
};

/* The four chains' differences, declared ONCE. A fifth chain is a row here plus
   one call in its handler — not a fifth copy of the rule. */
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
};

export type UnlinkedEditInput = {
  /** The parent this DOCUMENT names (header column). Falsy = nothing to bypass.
   *  Pass this when the handler already has it — GRN and Sales Invoice both read
   *  the header for their status gate, so it rides along for free. */
  parentId?: string | null | undefined;
  /** …or let the guard read it. The Return chains have no header read to piggy-back
   *  on, and an inline one in the handler is where the NEXT fail-open would live:
   *  a discarded error yields a null parent, a null parent reads as "names no
   *  parent", and that is an unconditional allow. Resolved here so it is resolved
   *  the same way, once, and its failure is refused rather than dropped. */
  parent?: {
    table: string;
    column: string;
    id: string;
    /** RESOLVED, not nullable: both callers sit behind requireActiveCompanyId,
     *  and an unresolved company here would read the parent unscoped — the guard
     *  would then answer about another company's document. */
    companyId: number;
  };
  /** The LINE's stored link column. Non-null = cap + recount already see it. */
  storedLink: string | null | undefined;
  /** The line's stored code, before this patch. */
  storedCode: string | null | undefined;
  /** The patch's code value. `undefined` means the patch does not touch it. */
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
  /* The cheap disqualifiers run BEFORE any read, so an ordinary qty or price
     edit — which is almost every edit — pays for nothing. */
  if (input.storedLink) return null;             // linked — the ceiling governs it
  if (input.patchCode === undefined) return null; // code untouched by this patch

  const effective = itemCodeKey(input.patchCode as string | null | undefined);
  if (!effective) return null;                   // blank/cleared — nothing to match
  const stored = itemCodeKey(input.storedCode);
  if (effective === stored) return null;         // no actual change

  const spec = CHAINS[chain];

  let parentId = String(input.parentId ?? '').trim();
  if (!parentId && input.parent) {
    const p = input.parent;
    const { data, error } = await scopeToCompanyId(
      sb.from(p.table).select(p.column).eq('id', p.id), p.companyId,
    ).maybeSingle();
    // A parent we could not read is not a parent that is absent.
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
  if (!parentId) return null;                    // header names no parent
  const codes = await spec.codesOf(sb, parentId);
  if (!codes.ok) {
    return {
      error: 'unlinked_check_failed',
      message:
        `Could not read the source ${spec.parentNoun} to check this line, so the edit was not `
        + `saved — try again (${codes.reason}).`,
    };
  }
  // Already in the bad state before this edit — not this actor's doing.
  if (stored && codes.codes.has(stored)) return null;
  if (!codes.codes.has(effective)) return null;  // genuinely ad-hoc, still allowed

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
