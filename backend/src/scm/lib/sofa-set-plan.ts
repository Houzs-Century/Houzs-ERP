// ----------------------------------------------------------------------------
// sofa-set-plan — the MRP engine's sofa SET walk (computeMrp section 8,
// company-2 pooled model), planned the way a sofa set SHIPS.
//
// Owner 2026-10-05, re-affirming the dye-lot rule on 2990-SO-2610-005:
// 「不能跨批次 1PO = 1batch 不能分开」. A sofa SET (every sofa module line of
// one SO at one warehouse) leaves the warehouse from ONE batch, and one batch
// IS one purchase order — the stored allocator only lights the set READY when
// a single received batch holds every module (so-stock-allocation.ts 7b /
// sofa-set-coverage.ts), and the DO gate refuses a two-batch set
// (ship-commitment.ts). The engine used to plan each MODULE from its own
// (warehouse, code, variant) pool, so on that order it handed the 2A(RHF) unit
// of batch 2990-PO-2607-018 to the set and asked purchasing for the 1A(LHF)
// alone — a PO that could never complete the set, because the new lot and the
// old one are two batches. The page said "stock" where the SO said PENDING,
// and the suggested order was a half-set nobody could ship.
//
// Supply is therefore read per BATCH (= PO number): the open lots that carry
// that batch_no (received units, the same view the allocator reads) plus the
// outstanding quantity still on that PO. A set takes a batch whole or names
// none:
//   1. a batch whose received lots already cover every module → `stock`,
//      FIFO-oldest first (the allocator's own tie-break);
//   2. else a batch whose lots + open PO cover every module → `po`, that PO
//      named on every line, earliest set ETA first (= its last module);
//   3. else a batch with units still ON ORDER that covers part of it AND was
//      raised for this set (a line of that PO carries one of the set's own
//      so_item_ids) → the PO is named and the rest is SHORT, so purchasing
//      completes THAT PO instead of raising a second one. A received batch
//      cannot be topped up — a second PO is a second dye lot — so stock-only
//      partial matches are not offered. Neither is another order's PO: BUG-65
//      (Nico/Sim 2026-10-07) — 2990-PO-2607-018 (L(LHF) + 2A(RHF), raised for
//      the cancelled 2990-SO-2607-024) shares only the 2A(RHF) with
//      2990-SO-2610-005 (1A(LHF) + 2A(RHF)), and naming it blocked Proceed PO
//      with "amend 2990-PO-2607-018" — a PO carrying a module this customer
//      never ordered;
//   4. else every module is SHORT: order the whole set, on one PO.
// Sets already LOCKED by the allocator (allocated_batch_no on every line,
// batch still covering) keep their batch before anyone else walks — the same
// carve computeMrp section 4c gives section 7, in set form.
//
// Pure decisions only — no database. mrp.ts reads the lots and PO supply and
// hands them in; mrp.test.ts drives the scenarios through computeMrp.
// ----------------------------------------------------------------------------

import { sofaStockKey, type SofaBatchStock } from './sofa-set-coverage';
import { WH_NONE } from './committed-shipments';

/** One pooled sofa demand line, as the engine bucketed it. */
export type SofaSetLine = {
  soItemId: string;
  docNo: string;
  /** composite(warehouse, item_code, variant_key) — the engine's bucket key. */
  bucketKey: string;
  whId: string | null;
  code: string;
  vkey: string;
  /** Units still to fulfil (effQty). */
  need: number;
  /** mfg_sales_order_items.allocated_batch_no — the allocator's whole-set lock. */
  lockedBatchNo: string | null;
  /** Effective delivery date (the engine's deliveryOf) — the walk's priority. */
  delivery: string | null;
};

/** One open PO line's supply in a bucket — mrp.ts's PoSupply shape. */
export type SofaSetPoSupply = { poNumber: string; eta: string | null; qtyLeft: number; supplierId: string | null };

/** PO number → the SO line ids its lines were raised from (purchase_order_items.so_item_id). */
export type SofaPoRaisedFor = ReadonlyMap<string, ReadonlySet<string>>;

/** What one module line is planned from. */
export type SofaPlan = {
  fromStock: number;
  need: number;
  poNumber: string | null;
  poEta: string | null;
  poSupplierId: string | null;
  /** The batch (= PO number) the WHOLE set is planned from; null = nothing covers it. */
  batchNo: string | null;
};

const byDateAsc = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
};

type Module = { bucketKey: string; whId: string | null; code: string; vkey: string; need: number };
type BatchPo = { qtyLeft: number; eta: string | null; supplierId: string | null };
type Fit = { batch: string; stockOnly: boolean; full: boolean; covered: number; onOrder: boolean; eta: string | null; supplierId: string | null };

/**
 * Plan every pooled sofa line from ONE batch per set. Mutates `lots.remaining`
 * and the `qtyLeft` of the entries in `poByBucket` as sets claim supply, so
 * pass clones if the caller still needs the originals.
 */
export function planSofaSets(
  lines: SofaSetLine[],
  lots: SofaBatchStock,
  poByBucket: Map<string, SofaSetPoSupply[]>,
  poRaisedFor: SofaPoRaisedFor,
): Map<string, SofaPlan> {
  const planByLine = new Map<string, SofaPlan>();
  const setsByKey = new Map<string, SofaSetLine[]>(); // `${wh}|${doc_no}` — the allocator's set key
  for (const l of lines) {
    const key = `${l.whId ?? WH_NONE}|${l.docNo}`;
    const arr = setsByKey.get(key) ?? [];
    arr.push(l);
    setsByKey.set(key, arr);
  }
  /* Open PO units per (PO number = batch, bucket). A bucket's OWN PO lines
     only — the '' fallback was removed on both paths (owner 2026-08-16). */
  const poOpenByBatch = new Map<string, Map<string, BatchPo>>();
  for (const [k, entries] of poByBucket) {
    for (const p of entries) {
      const perBucket = poOpenByBatch.get(p.poNumber) ?? new Map<string, BatchPo>();
      const cur = perBucket.get(k) ?? { qtyLeft: 0, eta: null, supplierId: p.supplierId };
      cur.qtyLeft += p.qtyLeft;
      // The set is complete when its LAST unit lands: latest line date wins.
      if (cur.eta == null || (p.eta != null && p.eta > cur.eta)) cur.eta = p.eta;
      perBucket.set(k, cur);
      poOpenByBatch.set(p.poNumber, perBucket);
    }
  }

  /* Two lines of the SAME module + variant (a symmetric sofa's two identical
     arms) are summed before comparing to a batch — findCoveringBatch's own
     audit fix (2026-06-03), kept here for the same reason. */
  const modulesOf = (set: SofaSetLine[]): Module[] => {
    const m = new Map<string, Module>();
    for (const l of set) {
      const cur = m.get(l.bucketKey) ?? { bucketKey: l.bucketKey, whId: l.whId, code: l.code, vkey: l.vkey, need: 0 };
      cur.need += l.need;
      m.set(l.bucketKey, cur);
    }
    return [...m.values()];
  };
  const lotQty = (batch: string, m: Module): number =>
    m.whId ? (lots.remaining.get(sofaStockKey(m.whId, batch, m.code, m.vkey)) ?? 0) : 0;
  const poQty = (batch: string, m: Module): number => poOpenByBatch.get(batch)?.get(m.bucketKey)?.qtyLeft ?? 0;
  const fitOf = (batch: string, mods: Module[]): Fit => {
    let stockOnly = true;
    let full = true;
    let covered = 0;
    let onOrder = false;
    let eta: string | null = null;
    let supplierId: string | null = null;
    for (const m of mods) {
      const lot = Math.min(lotQty(batch, m), m.need);
      const po = Math.min(poQty(batch, m), m.need - lot);
      if (lot < m.need) stockOnly = false;
      if (lot + po < m.need) full = false;
      covered += lot + po;
      if (poQty(batch, m) > 0) onOrder = true;
      if (po > 0) {
        const e = poOpenByBatch.get(batch)?.get(m.bucketKey);
        if (e) {
          if (eta == null || (e.eta != null && e.eta > eta)) eta = e.eta;
          supplierId ??= e.supplierId;
        }
      }
    }
    return { batch, stockOnly, full, covered, onOrder, eta, supplierId };
  };
  const receivedAt = (b: string): string => lots.receivedAt.get(b) ?? '';
  const candidates = (): string[] => [...new Set([...lots.batches, ...poOpenByBatch.keys()])];
  const raisedForSet = (batch: string, set: SofaSetLine[]): boolean => {
    const ids = poRaisedFor.get(batch);
    return !!ids && set.some((l) => ids.has(l.soItemId));
  };
  const chooseBatch = (set: SofaSetLine[]): Fit | null => {
    const mods = modulesOf(set);
    const fits = candidates().map((b) => fitOf(b, mods)).filter((f) => f.covered > 0);
    const stockOnly = fits.filter((f) => f.stockOnly);
    if (stockOnly.length > 0) {
      return stockOnly.sort((a, b) => receivedAt(a.batch).localeCompare(receivedAt(b.batch)) || a.batch.localeCompare(b.batch))[0]!;
    }
    const full = fits.filter((f) => f.full);
    if (full.length > 0) {
      return full.sort((a, b) => byDateAsc(a.eta, b.eta) || a.batch.localeCompare(b.batch))[0]!;
    }
    const partial = fits.filter((f) => f.onOrder && raisedForSet(f.batch, set));
    if (partial.length > 0) {
      return partial.sort((a, b) => (b.covered - a.covered) || byDateAsc(a.eta, b.eta) || a.batch.localeCompare(b.batch))[0]!;
    }
    return null;
  };
  /* Draw the set's units from `fit.batch` — received lots first, then the
     open PO — and record the plan on every line. A set the batch only partly
     covers still names it on EVERY line (allocSourceCoveringPo's question),
     and each line's own remainder is its shortage. */
  const planSet = (set: SofaSetLine[], fit: Fit | null): void => {
    for (const l of set) {
      if (!fit) {
        planByLine.set(l.soItemId, { fromStock: 0, need: l.need, poNumber: null, poEta: null, poSupplierId: null, batchNo: null });
        continue;
      }
      let need = l.need;
      const lotKey = l.whId ? sofaStockKey(l.whId, fit.batch, l.code, l.vkey) : null;
      const lotHave = lotKey ? (lots.remaining.get(lotKey) ?? 0) : 0;
      const fromStock = Math.min(lotHave, need);
      if (lotKey && fromStock > 0) lots.remaining.set(lotKey, lotHave - fromStock);
      need -= fromStock;
      const po = poOpenByBatch.get(fit.batch)?.get(l.bucketKey);
      if (po && need > 0) {
        const take = Math.min(po.qtyLeft, need);
        po.qtyLeft -= take;
        need -= take;
      }
      planByLine.set(l.soItemId, {
        fromStock,
        need,
        poNumber: fit.stockOnly ? null : fit.batch,
        poEta: fit.stockOnly ? null : fit.eta,
        poSupplierId: fit.stockOnly ? null : fit.supplierId,
        batchNo: fit.batch,
      });
    }
  };
  const setDelivery = (set: SofaSetLine[]): string | null =>
    set.reduce<string | null>((min, l) => (byDateAsc(l.delivery, min) < 0 ? l.delivery : min), null);
  // Same priority as the allocator and section 7: effective delivery date
  // ascending (nulls last), then SO doc number — so a scarce batch goes to
  // the earliest delivery and the walk never flips nondeterministically.
  const orderedSets = [...setsByKey.entries()].sort(([, a], [, b]) => {
    const byDate = byDateAsc(setDelivery(a), setDelivery(b));
    if (byDate !== 0) return byDate;
    return (a[0]?.docNo ?? '').localeCompare(b[0]?.docNo ?? '');
  });
  const planned = new Set<string>();
  for (const [key, set] of orderedSets) {
    const lock = set[0]!.lockedBatchNo;
    if (!lock || set.some((l) => l.lockedBatchNo !== lock)) continue;
    const fit = fitOf(lock, modulesOf(set));
    /* A stale lock (units transferred, stock-taken or oversold since the
       allocator last ran) reserves nothing: the set competes like any other. */
    if (!fit.stockOnly) continue;
    planSet(set, fit);
    planned.add(key);
  }
  for (const [key, set] of orderedSets) {
    if (planned.has(key)) continue;
    planSet(set, chooseBatch(set));
  }
  return planByLine;
}
