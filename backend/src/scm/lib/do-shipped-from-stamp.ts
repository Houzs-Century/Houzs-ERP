// do-shipped-from-stamp — writes and reads the per-line "where these goods came
// from" stamp on scm.delivery_order_items.shipped_from (mig 20261110T2300).
//
// Owner rule 2026-11-10: a confirmed DO keeps, for good, which PO(s) each line's
// goods came from and which rack(s) they left. The rule itself (who gets which
// lot / rack when lines share a product) is pure and shared with the backlog
// script: scripts/lib/do-shipped-from.mjs.
//
// Written once per line, only where the column is still NULL (the predicate on
// the UPDATE, plus a DB trigger that refuses changing a set stamp's core), and
// only when the line is COMPLETE: rack and PO known for its full qty (owner
// decision 2026-11-10). Called from the DO's ship chokepoint after the FIFO OUT
// and the rack stock-out, after an edit-after-ship resync, and nightly by
// do-shipped-from-retry.ts, so a line left open locks once its GRN gets a rack.
// Best-effort like the rack ledger: a failed stamp never blocks the ship, the
// line just keeps reading the worked-out answer.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { canonicalVariantKey, computeVariantKey, isServiceLine, type VariantAttrs } from '../shared';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { classifyLots, traceDoShipmentSources } from './source-po-trace';
import { variantTrackedCompany } from './binding-mode';
import { loadGrnRacksForPos } from './do-shipped-from-grn';
import { resolveDoLineWarehouses } from './do-line-warehouses';
import { afterResponse } from '../../lib/after-response';
// @ts-expect-error - plain .mjs, shared with scripts/stamp-do-shipped-from.mjs so the ship and the backlog stamp hold one rule
import { planShippedFrom, splitCompleteStamps, stampFitsLine, withReturn, withReship } from '../../../scripts/lib/do-shipped-from.mjs';

/** The rack-ledger reason the dispatch stock-out writes (do-rack-stock.ts). */
export const DO_RACK_OUT_REASON = 'Delivery order dispatch';

export type ShippedFromStamp = {
  v: 1;
  at: string;
  src: 'ship' | 'backfill';
  item_code: string;
  qty: number;
  pos: Array<{ po: string; qty: number | null }>;
  adj_qty: number;
  /** via 'dispatch': the DO's own STOCK_OUT; via 'grn': PO -> GRN line rack. */
  racks: Array<{ rack_id: string; label: string | null; qty: number; via?: 'dispatch' | 'grn'; po?: string; grn?: string }>;
  returns?: Array<{ at: string; why: string; reshipped_at?: string }>;
};

type LineRow = {
  id: string; item_code: string | null; item_group: string | null; variants: VariantAttrs | null;
  qty: number | null; rack_id: string | null; so_item_id: string | null; shipped_from: ShippedFromStamp | null;
};

const vkOf = (l: { item_group: string | null; variants: VariantAttrs | null }) =>
  computeVariantKey(l.item_group ?? null, l.variants ?? null);

/** stamps: only COMPLETE lines (rack and PO known for the full qty), the only
 *  ones ever written. open: every other unstamped line -> why it stays open
 *  ("no rack for 1 of 2; no PO for 2 of 2", "service line"). */
export type DoShippedFromPlan = { lines: LineRow[]; stamps: Map<string, ShippedFromStamp>; open: Map<string, string> };

/** READ-ONLY: the stamps the DO's unstamped goods lines would get from what the
 *  ledger and the rack ledger say right now; an incomplete line is left open
 *  (owner decision 2026-11-10). Null when the lines are unreadable.
 *  Shared by the ship chokepoint below and scripts/stamp-do-shipped-from.mjs
 *  (which reads through the pgrest shim and writes with its own checks). */
export async function planDoShippedFrom(
  sb: any, deliveryOrderId: string, companyId: number | null, src: 'ship' | 'backfill',
): Promise<DoShippedFromPlan | null> {
  /* Every read below refuses on error rather than reading "nothing": a stamp
     planned from a half-read ledger would lock a wrong or empty answer for good. */
  const { data: hdr, error: hdrErr } = await scopeToCompanyIdOrOpen(
    sb.from('delivery_orders').select('do_number, warehouse_id').eq('id', deliveryOrderId), companyId).maybeSingle();
  if (hdrErr) return null;
  const doNo = (hdr as { do_number?: string | null } | null)?.do_number ?? null;
  const headerWh = (hdr as { warehouse_id?: string | null } | null)?.warehouse_id ?? null;
  const { data: lineData, error: lineErr } = await scopeToCompanyIdOrOpen(
    sb.from('delivery_order_items')
      .select('id, item_code, item_group, variants, qty, rack_id, so_item_id, shipped_from')
      .eq('delivery_order_id', deliveryOrderId), companyId).order('line_no', { ascending: true });
  if (lineErr || !lineData) return null;
  const lines = lineData as LineRow[];
  if (!lines.some((l) => !l.shipped_from)) return { lines, stamps: new Map(), open: new Map() };

  const { data: consData, error: consErr } = await scopeToCompanyIdOrOpen(
    sb.from('inventory_lot_consumptions').select('lot_id, item_code, variant_key, qty_consumed')
      .eq('source_doc_type', 'DO').eq('source_doc_id', deliveryOrderId), companyId);
  if (consErr) return null;
  const cons = (consData ?? []) as Array<{ lot_id: string; item_code: string | null; variant_key: string | null; qty_consumed: number | null }>;
  const lotClass = await classifyLots(sb, cons.map((r) => r.lot_id));
  /* A variant-tracked company (binding-mode.ts) matches lines to ledger rows
     canonically: the OUT may carry the stocked bucket's older spelling of the
     spec. Company 1 keeps the exact string. */
  const idOf = (vk: string | null): string => (variantTrackedCompany(companyId) ? canonicalVariantKey(vk) : (vk ?? ''));
  const poUnits = cons.map((r) => {
    const cls = lotClass.get(r.lot_id);
    return { item_code: r.item_code, variant_key: idOf(r.variant_key), po: cls?.po ?? null, adjustment: cls?.adjustment ?? false, qty: Number(r.qty_consumed ?? 0) };
  });
  /* A batched OUT with no consumption (drop-ship shipped before its receipt)
     still names its PO: the batch is the expected PO number. */
  const consumed = new Set(poUnits.map((u) => `${u.item_code}::${u.variant_key}`));
  const { data: movData, error: movErr } = await scopeToCompanyIdOrOpen(
    sb.from('inventory_movements').select('item_code, variant_key, batch_no, qty')
      .eq('source_doc_type', 'DO').eq('source_doc_id', deliveryOrderId).eq('movement_type', 'OUT')
      .not('batch_no', 'is', null), companyId);
  if (movErr) return null;
  for (const m of (movData ?? []) as Array<{ item_code: string | null; variant_key: string | null; batch_no: string | null; qty: number | null }>) {
    if (!m.item_code || consumed.has(`${m.item_code}::${idOf(m.variant_key)}`)) continue;
    poUnits.push({ item_code: m.item_code, variant_key: idOf(m.variant_key), po: m.batch_no, adjustment: false, qty: Math.abs(Number(m.qty ?? 0)) });
  }
  /* The forward trace (what the DO detail showed until now) overrides the raw
     lots for company-1 hard-bound lines (BUG-103): the stamp must lock the same
     PO the screen named, not the lot plain FIFO happened to eat. */
  const poOverride = new Map<string, string[]>();
  try {
    const { byBucket } = await traceDoShipmentSources(sb, [deliveryOrderId]);
    const ledger = new Map<string, Set<string>>();
    for (const u of poUnits) if (u.po) (ledger.get(`${u.item_code}::${u.variant_key}`) ?? ledger.set(`${u.item_code}::${u.variant_key}`, new Set()).get(`${u.item_code}::${u.variant_key}`)!).add(u.po);
    const prefix = `${deliveryOrderId}::`;
    for (const [k, t] of byBucket) {
      if (!k.startsWith(prefix) || t.pos.length === 0) continue;
      const rest = k.slice(prefix.length);
      const sep = rest.indexOf('::');
      const b = sep < 0 || !variantTrackedCompany(companyId) ? rest : `${rest.slice(0, sep)}::${idOf(rest.slice(sep + 2))}`;
      const mine = ledger.get(b) ?? new Set<string>();
      if (t.pos.length !== mine.size || t.pos.some((p) => !mine.has(p))) poOverride.set(b, t.pos);
    }
  } catch { /* trace unreadable — the raw lots stand */ }

  let rackOuts: Array<{ item_code: string; rack_id: string | null; label: string | null; qty: number }> = [];
  if (doNo) {
    const { data: rackData, error: rackErr } = await scopeToCompanyIdOrOpen(
      sb.from('warehouse_rack_movements').select('item_code, rack_id, rack_label, quantity')
        .eq('movement_type', 'STOCK_OUT').eq('source_doc_no', doNo).eq('reason', DO_RACK_OUT_REASON), companyId);
    if (rackErr) return null;
    rackOuts = ((rackData ?? []) as Array<{ item_code: string; rack_id: string | null; rack_label: string | null; quantity: number | null }>)
      .map((r) => ({ item_code: r.item_code, rack_id: r.rack_id, label: r.rack_label, qty: Number(r.quantity ?? 0) }));
  }

  const at = new Date().toISOString();
  const planLines = (lineWh: Map<string, string | null> | null) => lines.map((l) => ({
    id: l.id, item_code: l.item_code, variant_key: idOf(vkOf(l)), qty: Number(l.qty ?? 0), rack_id: l.rack_id,
    warehouse_id: lineWh?.get(l.id) ?? null,
    goods: !isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code ?? '' }), shipped_from: l.shipped_from,
  }));
  const plan = (lineWh: Map<string, string | null> | null, grnRacks: unknown[]) => planShippedFrom({
    lines: planLines(lineWh), poUnits, poOverride, rackOuts, grnRacks, at, src,
  }) as Map<string, ShippedFromStamp>;
  const gate = (candidates: Map<string, ShippedFromStamp>): DoShippedFromPlan => {
    const { stamps, open } = splitCompleteStamps(planLines(null), candidates) as { stamps: Map<string, ShippedFromStamp>; open: Map<string, string> };
    return { lines, stamps, open };
  };
  const first = plan(null, []);
  /* A line that left no dispatch rack follows its PO(s) to the GRN rack(s)
     (owner rule 2026-11-10). Read only when such a line exists; the second plan
     is the same pure rule with the chain added, so the POs cannot move. */
  const rackless = lines.filter((l) => first.get(l.id)?.racks.length === 0 && first.get(l.id)!.pos.length > 0);
  if (rackless.length === 0) return gate(first);
  try {
    const lineWh = await resolveDoLineWarehouses(sb, lines, headerWh, companyId ?? undefined);
    const grnRacks = await loadGrnRacksForPos(sb,
      [...new Set(rackless.flatMap((l) => first.get(l.id)!.pos.map((p) => p.po)))],
      [...new Set(rackless.map((l) => l.item_code as string))],
      [...new Set(rackless.map((l) => lineWh.get(l.id)).filter((w): w is string => !!w))],
      companyId);
    return gate(plan(lineWh, grnRacks));
  } catch {
    return null; // a half-read GRN chain must not lock "no rack" for good
  }
}

/** Stamp every COMPLETE unstamped goods line of a shipped DO (write-once: the
 *  UPDATE only matches a NULL column); an incomplete line stays NULL for the
 *  next ship / resync / nightly retry. Returns how many lines changed. Never throws. */
export async function stampDoShippedFrom(sb: any, deliveryOrderId: string, companyId: number | null): Promise<number> {
  try {
    const planned = await planDoShippedFrom(sb, deliveryOrderId, companyId, 'ship');
    if (!planned) return 0;
    let wrote = 0;
    for (const [lineId, stamp] of planned.stamps) {
      const { data: back, error: writeErr } = await scopeToCompanyIdOrOpen(
        sb.from('delivery_order_items').update({ shipped_from: stamp }).eq('id', lineId).is('shipped_from', null), companyId)
        .select('id');
      if (writeErr) throw new Error(writeErr.message);
      wrote += (back as unknown[]).length;
    }
    return wrote + await markReshipped(sb, planned.lines, companyId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[do-shipped-from] stamp failed:', e);
    return 0;
  }
}

/** The request-path entry: the stamp runs AFTER the response (afterResponse ->
 *  waitUntil), never awaited by the ship / resync, so confirming a DO is not
 *  slower. Lost or failed: the lines stay open and the nightly pass retries them.
 *  Outside a request (tests, scripts) it runs inline. */
export function queueDoShippedFromStamp(sb: any, deliveryOrderId: string, companyId: number | null): Promise<void> {
  return afterResponse('do-shipped-from stamp', () => stampDoShippedFrom(sb, deliveryOrderId, companyId));
}

async function markReshipped(sb: any, lines: LineRow[], companyId: number | null): Promise<number> {
  const at = new Date().toISOString();
  let n = 0;
  for (const l of lines) {
    const next = withReship(l.shipped_from, at);
    if (!next) continue;
    await scopeToCompanyIdOrOpen(sb.from('delivery_order_items').update({ shipped_from: next }).eq('id', l.id), companyId);
    n += 1;
  }
  return n;
}

/** A revert to draft or a cancel put this DO's stock back: note it on every
 *  stamped line. The PO and rack stay locked. Never throws. */
export async function markDoShippedFromReturned(sb: any, deliveryOrderId: string, companyId: number | null, why: 'revert' | 'cancel'): Promise<void> {
  try {
    const { data, error } = await scopeToCompanyIdOrOpen(
      sb.from('delivery_order_items').select('id, shipped_from').eq('delivery_order_id', deliveryOrderId)
        .not('shipped_from', 'is', null), companyId);
    if (error) throw new Error(error.message);
    const at = new Date().toISOString();
    for (const l of (data ?? []) as Array<{ id: string; shipped_from: ShippedFromStamp | null }>) {
      const next = withReturn(l.shipped_from, at, why);
      if (next) await scopeToCompanyIdOrOpen(sb.from('delivery_order_items').update({ shipped_from: next }).eq('id', l.id), companyId);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[do-shipped-from] return note failed:', e);
  }
}

export type SourceState = 'locked' | 'worked_out' | null;

/** Readers: a stamped line shows its stamp; any other goods line keeps the
 *  worked-out answer and says so. PURE. */
export function withShippedFromStamp<T extends Record<string, unknown>>(items: T[]): Array<T & { source_state: SourceState }> {
  return items.map((it) => {
    const code = (it.item_code as string | null) ?? null;
    if (isServiceLine({ itemGroup: (it.item_group as string | null) ?? null, itemCode: code ?? '' })) return { ...it, source_state: null };
    const s = it.shipped_from as ShippedFromStamp | null | undefined;
    if (!stampFitsLine(s, code)) return { ...it, source_state: 'worked_out' as const };
    const stamp = s as ShippedFromStamp;
    return {
      ...it,
      source_pos: stamp.pos.map((p) => p.po),
      source_adj: Number(stamp.adj_qty) > 0,
      racks: [...new Set(stamp.racks.map((r) => r.label).filter((x): x is string => !!x))],
      source_state: 'locked' as const,
    };
  });
}
