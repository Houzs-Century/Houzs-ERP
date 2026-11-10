/* do-shipped-from — the PURE rule that decides what a delivery-order line keeps,
 * for good, about where its goods came from: the purchase order(s) of the lots it
 * consumed and the rack(s) it was taken off.
 *
 * Owner rule 2026-11-10: once a DO is confirmed, each line must keep WHICH PO and
 * WHICH rack, and nothing re-assigns them later ("要确保知道拿的是什么PO，不会之后
 * 又乱乱给了，lock了之后 rack number 也是"). Until then the DO detail re-derived both
 * at read time from the ledger, so a FIFO repair, a lot relabel or a re-cost could
 * change what an old DO printed.
 *
 * One rule, two callers: the ship chokepoint (scm/lib/do-shipped-from-stamp.ts) and
 * the backlog stamp (scripts/stamp-do-shipped-from.mjs). Neither writes a line that
 * already carries a stamp, and this file never returns one for such a line.
 *
 * THE LEDGER IS PER BUCKET, THE STAMP IS PER LINE. Lot consumptions are keyed by
 * (item_code, variant_key) and rack stock-outs by item_code, not by DO line, so two
 * lines of one product share a pool. Lines already stamped take their share out of
 * the pool first (a line added after the ship must not claim the first line's lot);
 * the rest is handed out in line order. A line with an explicit rack pick takes
 * from that rack before anyone else.
 *
 * A line with nothing known (no PO, no stock-adjustment units, no rack) is NOT
 * stamped: an empty stamp would lock in "unknown" and hide the bound-PO fallback.
 *
 * Stamp shape (scm.delivery_order_items.shipped_from, mig 20261110T2300):
 *   { v: 1, at, src: 'ship' | 'backfill', item_code, qty,
 *     pos: [{ po, qty }],            qty null only when the PO came from the
 *                                    hard-bound rule and several POs share a line
 *     adj_qty,                       units from a PO-less stock adjustment lot
 *     racks: [{ rack_id, label, qty }],
 *     returns?: [{ at, why, reshipped_at? }] }   appended by revert / cancel only
 */

export const SHIPPED_FROM_VERSION = 1;

const bucketOf = (code, vk) => `${code ?? ''}::${vk ?? ''}`;
const numeric = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/** True when a line row carries a usable stamp for its CURRENT item. A stamp
 *  whose item no longer matches (the line was re-pointed while back in draft)
 *  speaks about other goods and is ignored by readers. */
export function stampFitsLine(stamp, itemCode) {
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return false;
  if (stamp.v !== SHIPPED_FROM_VERSION) return false;
  return !itemCode || !stamp.item_code || stamp.item_code === itemCode;
}

/** The rack label(s) a stamped line left from, joined for a one-cell sheet, or
 *  null when the line carries no usable stamp or the stamp names no rack. */
export function stampRackLabel(stamp, itemCode) {
  if (!stampFitsLine(stamp, itemCode)) return null;
  const labels = [...new Set((stamp.racks ?? []).map((r) => r.label).filter(Boolean))];
  return labels.length > 0 ? labels.join(', ') : null;
}

function take(pool, key, want) {
  const out = [];
  let left = want;
  for (const e of pool) {
    if (left <= 0) break;
    if (key && e.key !== key) continue;
    if (e.qty <= 0) continue;
    const n = Math.min(e.qty, left);
    e.qty -= n;
    left -= n;
    out.push({ ...e, qty: n });
  }
  return out;
}

function drain(pool, keyOf, entries) {
  for (const s of entries ?? []) {
    let left = Number(s.qty ?? 0);
    for (const e of pool) {
      if (left <= 0) break;
      if (e.key !== keyOf(s) || e.qty <= 0) continue;
      const n = Math.min(e.qty, left);
      e.qty -= n;
      left -= n;
    }
  }
}

/**
 * @param {object} input
 * @param {Array<{ id: string, item_code: string, variant_key: string, qty: number, rack_id: string|null, goods: boolean, shipped_from: object|null }>} input.lines  in line order
 * @param {Array<{ item_code: string, variant_key: string, po: string|null, adjustment: boolean, qty: number }>} input.poUnits  the DO's consumed units, classified
 * @param {Map<string, string[]>} [input.poOverride]  `${code}::${vk}` -> the POs the forward trace names when it differs from the raw lots (BUG-103 hard-bound lines)
 * @param {Array<{ item_code: string, rack_id: string|null, label: string|null, qty: number }>} input.rackOuts  the DO's dispatch STOCK_OUT rack movements
 * @param {string} input.at  ISO timestamp
 * @param {'ship'|'backfill'} input.src
 * @returns {Map<string, object>}  line id -> new stamp, only for unstamped lines with something known
 */
export function planShippedFrom({ lines, poUnits, poOverride, rackOuts, at, src }) {
  const goods = lines.filter((l) => l.goods && Number(l.qty) > 0 && l.item_code);

  /* PO pool per bucket, aggregated per PO (adjustment units under one key). */
  const poPool = new Map();
  for (const u of poUnits) {
    const qty = Math.abs(Number(u.qty ?? 0));
    if (!(qty > 0) || !u.item_code) continue;
    if (!u.po && !u.adjustment) continue;
    const b = bucketOf(u.item_code, u.variant_key);
    const arr = poPool.get(b) ?? [];
    const key = u.po ? `po:${u.po}` : 'adj';
    const cur = arr.find((e) => e.key === key);
    if (cur) cur.qty += qty;
    else arr.push({ key, po: u.po ?? null, qty });
    poPool.set(b, arr);
  }
  for (const arr of poPool.values()) arr.sort((a, b) => (a.key === 'adj') - (b.key === 'adj') || numeric(a.key, b.key));

  const rackPool = new Map();
  for (const r of rackOuts) {
    const qty = Number(r.qty ?? 0);
    if (!(qty > 0) || !r.item_code || !r.rack_id) continue;
    const arr = rackPool.get(r.item_code) ?? [];
    const cur = arr.find((e) => e.key === r.rack_id);
    if (cur) cur.qty += qty;
    else arr.push({ key: r.rack_id, label: r.label ?? null, qty });
    rackPool.set(r.item_code, arr);
  }

  /* Stamped lines first: their share is gone from the pool. */
  for (const l of goods) {
    if (!l.shipped_from) continue;
    const s = l.shipped_from;
    drain(poPool.get(bucketOf(l.item_code, l.variant_key)) ?? [], (p) => (p.po ? `po:${p.po}` : 'adj'), [
      ...(s.pos ?? []).filter((p) => p.qty != null),
      ...(Number(s.adj_qty) > 0 ? [{ po: null, qty: s.adj_qty }] : []),
    ]);
    drain(rackPool.get(l.item_code) ?? [], (r) => r.rack_id, s.racks);
  }

  const open = goods.filter((l) => !l.shipped_from);
  const racksByLine = new Map();
  /* Explicit picks take from their own rack before the auto-picked lines. */
  for (const l of [...open.filter((x) => x.rack_id), ...open.filter((x) => !x.rack_id)]) {
    const pool = rackPool.get(l.item_code) ?? [];
    const got = [
      ...(l.rack_id ? take(pool, l.rack_id, Number(l.qty)) : []),
    ];
    const rest = Number(l.qty) - got.reduce((s, g) => s + g.qty, 0);
    if (rest > 0) got.push(...take(pool, null, rest));
    const merged = new Map();
    for (const g of got) {
      const cur = merged.get(g.key);
      if (cur) cur.qty += g.qty;
      else merged.set(g.key, { rack_id: g.key, label: g.label, qty: g.qty });
    }
    racksByLine.set(l.id, [...merged.values()].sort((a, b) => numeric(a.label ?? '', b.label ?? '')));
  }

  const out = new Map();
  for (const l of open) {
    const b = bucketOf(l.item_code, l.variant_key);
    let pos = [];
    let adj = 0;
    const override = poOverride?.get(b);
    if (override && override.length > 0) {
      pos = override.length === 1
        ? [{ po: override[0], qty: Number(l.qty) }]
        : [...override].sort(numeric).map((po) => ({ po, qty: null }));
    } else {
      for (const g of take(poPool.get(b) ?? [], null, Number(l.qty))) {
        if (g.key === 'adj') adj += g.qty;
        else {
          const cur = pos.find((p) => p.po === g.po);
          if (cur) cur.qty += g.qty;
          else pos.push({ po: g.po, qty: g.qty });
        }
      }
      pos.sort((a, b2) => numeric(a.po, b2.po));
    }
    const racks = racksByLine.get(l.id) ?? [];
    if (pos.length === 0 && adj <= 0 && racks.length === 0) continue;
    out.set(l.id, {
      v: SHIPPED_FROM_VERSION, at, src, item_code: l.item_code, qty: Number(l.qty),
      pos, adj_qty: adj, racks,
    });
  }
  return out;
}

/** The stamp after a revert / cancel put the stock back: the core is untouched
 *  (the DB trigger refuses anything else), one return entry is appended. A second
 *  reversal with no re-ship in between (a retried cancel) appends nothing.
 *  Returns null when nothing changes. */
export function withReturn(stamp, at, why) {
  if (!stamp || typeof stamp !== 'object') return null;
  const returns = Array.isArray(stamp.returns) ? stamp.returns : [];
  const last = returns[returns.length - 1];
  if (last && !last.reshipped_at) return null;
  return { ...stamp, returns: [...returns, { at, why }] };
}

/** The stamp when its line ships again after a reversal: the locked PO and rack
 *  stay; the open return entry is closed with the re-ship time. */
export function withReship(stamp, at) {
  if (!stamp || typeof stamp !== 'object') return null;
  const returns = Array.isArray(stamp.returns) ? stamp.returns : [];
  const last = returns[returns.length - 1];
  if (!last || last.reshipped_at) return null;
  return { ...stamp, returns: [...returns.slice(0, -1), { ...last, reshipped_at: at }] };
}
