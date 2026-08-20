/**
 * The WRITE half of the delivery-fee derivation: turn the derived
 * `ServiceLineSpec`s into rows, hand them to `scm.rebuild_mfg_so_delivery_lines`
 * under that function's per-doc_no advisory lock, and record the move.
 *
 * It lives here rather than inline in `recomputeDeliveryFeeCore` because of
 * WHERE THE LOCK IS. The RPC locks; the derivation READS before it. Two line
 * PATCHes from one Save — `runSoLineWrites` fans the dirty-line stage out with
 * `Promise.allSettled` (`so-add-lines.ts:184` -> `:124`), while the ADD stage is
 * already sequential for exactly this class of reason — can therefore both
 * derive from the same pre-edit snapshot, and the second write puts the
 * operator's figure back:
 *
 *   P_fee   writes discount_sen = 12500 (250 -> 125), reads, derives 125
 *   P_sofa  reads BEFORE that commit, derives 250 (discount 0)
 *   P_fee   takes the lock, writes 125
 *   P_sofa  takes the lock, writes 250      <- quoted RM 125, invoice RM 250
 *
 * The lock made that ordering deterministic; it never made it impossible.
 * Migration 0314 closes it: the caller passes the operator-owned fee state it
 * derived FROM, the function re-reads that state under the lock, and returns
 * FALSE without writing when it has moved. `stale` here is that FALSE, and the
 * caller re-derives from scratch and tries again.
 */
import { recordSoAudit } from './so-audit';
import { todayMyt } from './my-time';
import { deliveryFeeStateKey, type ServiceLineSpec } from '../shared/service-lines';

/** How many times a derivation may be re-run after the state moved under it.
 *  Two writers settle on the second attempt; the third is slack for a third
 *  writer. Inside `runScmPgCommand` convergence is guaranteed rather than
 *  likely — the advisory xact lock the first call took is held for the rest of
 *  that transaction, so nothing can move the state under attempt two. */
export const DELIVERY_REBUILD_MAX_ATTEMPTS = 3;

/** A fee line as the derivation read it, before the rebuild. */
export type LiveDeliveryLine = {
  id?: string | null;
  item_code: string;
  total_sen: number | null;
  unit_price_sen?: number | null;
  discount_sen?: number | null;
  qty?: number | null;
};

export type DeliveryRebuildOutcome =
  /** Written. `netFeeSen` is what the header now mirrors. */
  | { status: 'written'; netFeeSen: number }
  /** Refused: the fee lines moved between the read and the lock. Re-derive. */
  | { status: 'stale' };

/** Build the rebuilt SVC-DELIVERY* rows, exactly as the RPC expects them.
 *  `disc` is the operator discount recovered by `recoverOperatorDeliveryState`,
 *  clamped to THIS rebuilt line's own total — a fee line can never go negative,
 *  and a component that disappears on rebuild drops its discount rather than
 *  migrating it to money it never named. */
export function buildDeliveryRebuildRows(
  specs: ServiceLineSpec[],
  ctx: {
    docNo: string;
    keptMaxLineNo: number;
    discountByCode: Map<string, number>;
    debtorName: string | null;
    venue: string | null;
    customerDeliveryDate: string | null;
  },
): Array<Record<string, unknown>> {
  const lineDateToday = todayMyt();
  return specs.map((spec, i) => {
    const disc = Math.min(ctx.discountByCode.get(spec.itemCode) ?? 0, spec.totalSen), net = spec.totalSen - disc;
    return {
      doc_no: ctx.docNo,                              // NOT NULL — omitting it silently dropped the line (the bug)
      line_no: ctx.keptMaxLineNo >= 0 ? ctx.keptMaxLineNo + 1 + i : null,
      line_date: lineDateToday,
      debtor_name: ctx.debtorName,
      item_group: 'service',
      item_code: spec.itemCode,
      description: spec.description,
      description2: null,
      remark: spec.remark ?? null,
      uom: 'UNIT',
      qty: spec.qty,
      unit_price_sen: spec.unitPriceSen,
      discount_sen: disc,
      total_sen: net,
      total_inc_sen: net,
      balance_sen: net,
      variants: null,
      unit_cost_sen: 0,
      line_cost_sen: 0,
      line_margin_sen: net,
      divan_price_sen: 0,
      leg_price_sen: 0,
      special_order_price_sen: 0,
      custom_specials: null,
      line_delivery_date: ctx.customerDeliveryDate,
      line_delivery_date_overridden: false,
      warehouse_id: null,
      branding: null,
      venue: ctx.venue,
      stock_status: 'READY',
    };
  });
}

/**
 * Re-derive the SVC-DELIVERY* lines and stamp the header as ONE atomic RPC
 * (0214, ported from 2990's 0211). As two statements (delete, then insert) two
 * rebuilds interleaved and DOUBLED the fee on the bill (SO-2606-043 2026-06-28,
 * SO-2607-010 2026-07-12) — READ COMMITTED hides the first transaction's rows
 * from the second DELETE — so the RPC takes a per-doc_no advisory xact lock. It
 * also REUSES each fee line rather than replacing it (0310): a DO can carry a
 * fee line and so_item_id is ON DELETE SET NULL (0235), so replacing one
 * silently blanked that DO's link, leaving a same-item_code row that looked
 * untouched. Lines pair per item_code by POSITION (CROSS appears twice on a
 * follow-up) — keep `specs` order.
 *
 * `liveLines` is what the derivation READ. It becomes `p_expect_state`, and a
 * mismatch under the lock is answered with `stale` rather than a write (0314).
 */
export async function applyDeliveryFeeRebuild(
  sb: any,
  args: {
    docNo: string;
    sourceDocNo: string | null;
    rows: Array<Record<string, unknown>>;
    liveLines: LiveDeliveryLine[];
  },
): Promise<DeliveryRebuildOutcome> {
  const { docNo, sourceDocNo, rows, liveLines } = args;
  /* company_id is NOT passed: the RPC reads it off the SO header, so a rebuilt
     line can never land in another company (mig 0083 made it NOT NULL). */
  const netFeeSen = rows.reduce((s, r) => s + Number(r.total_sen ?? 0), 0); // header mirrors the LINES: net after discounts (owner 2026-08-07)
  const expectState = deliveryFeeStateKey(liveLines);
  if (expectState === null) {
    /* eslint-disable-next-line no-console */
    console.error('[so-redetect] a fee line arrived with no id — rebuilding without the 0314 staleness check:', docNo);
  }
  const { data: rebuilt, error: rebuildErr } = await sb.rpc('rebuild_mfg_so_delivery_lines', {
    p_doc_no: docNo,
    p_source_doc_no: sourceDocNo,
    p_delivery_fee_sen: netFeeSen,
    p_rows: rows,
    p_expect_state: expectState,
  });
  /* FALSE is not a failure — it is the lock telling us our inputs are stale.
     Nothing was written, so there is nothing to undo and nothing to log as an
     error; the caller re-reads and derives again. */
  if (!rebuildErr && rebuilt === false) return { status: 'stale' };
  if (rebuildErr) {
    if (sb?.__atomicCommand === true) throw new Error(`Delivery line rebuild failed: ${rebuildErr.message}`);
    /* eslint-disable-next-line no-console */ console.error('[so-redetect] delivery line rebuild failed:', rebuildErr.message);
    return { status: 'written', netFeeSen };
  }
  /* Owner 2026-08-12 — this rebuild ADDS, REPRICES and DELETES SVC-DELIVERY*
     lines on a live order, and until now it did so with no trace whatsoever.
     2990-SO-2608-017 grew a RM250 delivery line at 01:38 and its History showed
     only the SO's creation: the money moved and the timeline stayed silent. It
     is automation, not a person, so it logs as source 'automation' exactly like
     the POS deposit and the free-gift reconcile — "nobody did it" is a
     legitimate audit answer, "it never happened" is not.

     Only a real move is recorded (an unchanged re-derivation runs on every line
     edit and would otherwise flood the timeline). Best-effort by recordSoAudit's
     design; the fee is already committed either way. */
  const priorFeeSen = liveLines.reduce((s, l) => s + Number(l.total_sen ?? 0), 0);
  if (priorFeeSen !== netFeeSen) {
    await recordSoAudit(sb, {
      docNo,
      action: priorFeeSen === 0 ? 'ADD_LINE' : (netFeeSen === 0 ? 'DELETE_LINE' : 'UPDATE_LINE'),
      source: 'automation',
      note: 'Auto: delivery fee lines re-derived',
      fieldChanges: [
        { field: 'itemCode', to: 'SVC-DELIVERY' },
        { field: 'deliveryFeeSen', from: priorFeeSen, to: netFeeSen },
      ],
    });
  }
  return { status: 'written', netFeeSen };
}
