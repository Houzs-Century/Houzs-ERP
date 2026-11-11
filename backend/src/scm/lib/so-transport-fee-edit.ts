// ----------------------------------------------------------------------------
// so-transport-fee-edit — the transport-fee rule (shared/so-transport-fee.ts) on
// an EDIT of a live order (owner 2026-11-11: 「改单的话也是要能够 lock」).
//
// Loads the order as it stands, applies the one change the route is about to
// write (a new State, a re-priced or re-coded line, a deleted line), and asks
// transportFeeEditProblem whether THIS change breaks the rule. A DRAFT is never
// judged here: drafts stay freely saveable and are judged when confirmed.
// ----------------------------------------------------------------------------
import type { SaveProblem } from '../shared/so-save-problems';
import { companyNeedsTransportFee, transportFeeEditProblem, type TransportFeeLine } from '../shared/so-transport-fee';
import { scopeToCompanyId } from './companyScope';

export type SoTransportFeeChange =
  | { kind: 'header'; state: string | null; country: string | null }
  | { kind: 'line'; itemId: string; after: TransportFeeLine | null }
  /* An amendment: an optional State move plus line ops. A null price keeps the
     stored price on a CHANGE; on an ADD it takes the catalog price, which this
     check cannot see, so it is judged as RM 0 (type the fee on the line). */
  | {
      kind: 'amendment';
      state: { state: string | null; country: string | null } | null;
      lines: ReadonlyArray<{ op: 'ADD' | 'CHANGE' | 'REMOVE'; itemId: string | null; itemCode: string | null; qty: number | null; unitPriceSen: number | null }>;
    };

type LineRow = {
  id: string; item_code: string | null; item_group: string | null; description: string | null;
  qty: number | null; unit_price_sen: number | null; discount_sen: number | null;
  total_sen: number | null; cancelled: boolean | null;
};

export async function soTransportFeeEditProblem(
  sb: any,
  args: { docNo: string; companyId: number; companyCode: string | null; change: SoTransportFeeChange },
): Promise<SaveProblem | null> {
  if (!companyNeedsTransportFee(args.companyCode)) return null;
  const { data: head, error: headErr } = await scopeToCompanyId(
    sb.from('mfg_sales_orders').select('status, customer_state, customer_country'), args.companyId,
  ).eq('doc_no', args.docNo).maybeSingle();
  if (headErr) return checkFailed(headErr.message);
  const h = head as { status: string | null; customer_state: string | null; customer_country: string | null } | null;
  if (!h || String(h.status ?? '').toUpperCase() === 'DRAFT') return null;

  const { data: rows, error: rowsErr } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, description, qty, unit_price_sen, discount_sen, total_sen, cancelled').eq('doc_no', args.docNo);
  /* A failed read must not read as "no lines": that would refuse a good edit,
     or (worse) let one through on a different branch. Say what happened. */
  if (rowsErr) return checkFailed(rowsErr.message);
  const live = ((rows ?? []) as LineRow[]).filter((r) => !r.cancelled);
  const toFee = (r: LineRow): TransportFeeLine => ({
    itemCode: r.item_code, description: r.description, itemGroup: r.item_group, amountSen: Number(r.total_sen ?? 0),
  });
  const before = { state: h.customer_state, country: h.customer_country, lines: live.map(toFee) };
  const change = args.change;
  const after = change.kind === 'header'
    ? { ...before, state: change.state, country: change.country }
    : change.kind === 'line'
    ? {
        ...before,
        lines: live.flatMap((r) => (r.id !== change.itemId ? [toFee(r)] : change.after ? [change.after] : [])),
      }
    : amendmentAfter(before, live, change, toFee);
  return transportFeeEditProblem(args.companyCode, before, after);
}

function amendmentAfter(
  before: { state: string | null; country: string | null; lines: TransportFeeLine[] },
  live: LineRow[],
  change: Extract<SoTransportFeeChange, { kind: 'amendment' }>,
  toFee: (r: LineRow) => TransportFeeLine,
) {
  const byId = new Map(change.lines.filter((l) => l.itemId).map((l) => [l.itemId as string, l]));
  const kept = live.flatMap((r): TransportFeeLine[] => {
    const op = byId.get(r.id);
    if (!op) return [toFee(r)];
    if (op.op === 'REMOVE') return [];
    if (op.qty == null && op.unitPriceSen == null && op.itemCode == null) return [toFee(r)];
    const qty = op.qty ?? Number(r.qty ?? 1);
    const unit = op.unitPriceSen ?? Number(r.unit_price_sen ?? 0);
    return [{
      itemCode: op.itemCode ?? r.item_code,
      description: op.itemCode && op.itemCode !== r.item_code ? null : r.description,
      itemGroup: op.itemCode && op.itemCode !== r.item_code ? null : r.item_group,
      amountSen: qty * unit - Number(r.discount_sen ?? 0),
    }];
  });
  const added = change.lines.filter((l) => l.op === 'ADD').map((l): TransportFeeLine => ({
    itemCode: l.itemCode, description: null, itemGroup: null, amountSen: (l.qty ?? 1) * (l.unitPriceSen ?? 0),
  }));
  return {
    state: change.state ? change.state.state : before.state,
    country: change.state ? change.state.country : before.country,
    lines: [...kept, ...added],
  };
}

const checkFailed = (reason: string): SaveProblem => ({
  code: 'transport_fee_check_failed',
  message: `Could not check this order's transport fee, so the change was not saved; try again (${reason}).`,
  field: 'Transport fee',
});
