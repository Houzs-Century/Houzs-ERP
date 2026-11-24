// ----------------------------------------------------------------------------
// do-goods — a delivery order's goods value: its own lines without the service
// lines, bucketed as its header roll-up buckets them (do-totals.ts,
// isServiceLine). What the Singapore carriers charge their shares of (owner
// 2026-11-24: 「based on good」, confirmed as the order total less its service
// part). Read for a rate card's Per DO charge (do-charge.ts). A DO's own lines,
// not its order's: a follow-up DO carries only what it delivers.
// ----------------------------------------------------------------------------
import { isServiceLine } from '../shared';
import { chunkIn } from './paginate-all';

type Row = Record<string, unknown>;
// The scm tables are not in the generated Supabase types; the same narrow
// bridge as delivery-rate-cards.ts rc().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (sb: unknown): any => sb;

/** A DO's goods value in sen from its lines: every line but the service ones. PURE. */
export function doGoodsSen(lines: ReadonlyArray<Row>): number {
  let sen = 0;
  for (const l of lines) {
    const itemGroup = l.item_group == null ? null : String(l.item_group).toLowerCase();
    const itemCode = l.item_code == null ? null : String(l.item_code);
    if (isServiceLine({ itemGroup, itemCode })) continue;
    sen += Math.round(Number(l.line_total_sen ?? 0)) || 0;
  }
  return Math.max(0, sen);
}

/** Each DO's goods value from its lines, narrowed by `scope`; a DO with no lines is 0. */
export async function loadDoGoods(
  scope: <Q>(query: Q) => Q, sb: unknown, doIds: readonly string[],
): Promise<{ ok: true; goods: Map<string, number> } | { ok: false; reason: string }> {
  const ids = [...new Set(doIds)];
  const goods = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return { ok: true, goods };
  const rows = await chunkIn<Row>(ids, (b, from, to) =>
    scope(db(sb).from('delivery_order_items').select('delivery_order_id, item_code, item_group, line_total_sen'))
      .in('delivery_order_id', b).order('delivery_order_id').range(from, to));
  if (rows.error) return { ok: false, reason: rows.error.message };
  const byDo = new Map<string, Row[]>();
  for (const r of rows.data) {
    const k = String(r.delivery_order_id);
    (byDo.get(k) ?? byDo.set(k, []).get(k)!).push(r);
  }
  for (const [id, lines] of byDo) goods.set(id, doGoodsSen(lines));
  return { ok: true, goods };
}
