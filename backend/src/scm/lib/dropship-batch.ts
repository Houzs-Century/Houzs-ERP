// ----------------------------------------------------------------------------
// dropship-batch — resolve the EXPECTED production batch for a sofa SO line
// that is being shipped as a supplier-direct drop-ship (port of 2990 07c45728).
//
// A sofa "batch" = batch_no = the source production PO number. For a normal
// ship the allocator only locks mfg_sales_order_items.allocated_batch_no once
// a batch is PHYSICALLY received. A drop-ship ships BEFORE receipt -- the
// operator is forcing the KNOWN expected batch ahead of the GRN. We derive
// that batch from the PO raised against this SO line:
//
//     scm.purchase_order_items.so_item_id = <SO line id>
//        -> scm.purchase_orders.po_number          (= batch_no the GRN stamps)
//        -> scm.purchase_orders.expected_at / revised dates  (ETA)
//
// GUARDRAIL: a sofa line may only drop-ship if it HAS a bound PO (so the
// incoming dye-lot batch is known). No PO -> the caller blocks; the OUT would
// otherwise have no batch to net against on receipt.
//
// HARDENING (audit 2026-06-26):
//   H1 — only LIVE POs count. A CANCELLED or DRAFT PO will never receive a
//        GRN under its number, so a line whose only binding is dead resolves
//        to "no PO" (drop-ship correctly blocked) instead of stamping a batch
//        that can never net out.
//   H3 — >1 live bound PO makes the expected batch AMBIGUOUS: the OUT would be
//        stamped with one PO's number while the GRN may arrive under the
//        other, stranding the drop-ship COGS at 0 forever. Guard/offer paths
//        (buildDropshipOffenders) BLOCK the drop-ship (poNumber null +
//        multiPo flag so the 409 can say why). Movement-write paths keep the
//        deterministic most-recent-live-PO pick ('latest') so an ALREADY
//        drop-shipped DO keeps resolving the same bucket its OUT was stamped
//        with (a resync must never fall back to an un-batched OUT).
// ----------------------------------------------------------------------------

export type ExpectedBatch = {
  /** = scm.purchase_orders.po_number — the batch_no the GRN will stamp on its
   *  IN. null when the batch cannot be resolved (only possible in 'block'
   *  mode: >1 live bound PO — see `multiPo`). */
  poNumber: string | null;
  /** Effective ETA = GREATEST(expected_at, supplier_delivery_date_2..4); null if none. */
  eta: string | null;
  /** H3 — true when the SO line is bound to MORE THAN ONE live PO, so the
   *  expected batch is ambiguous. Only set in 'block' mode. */
  multiPo?: boolean;
};

/** PO statuses that can still receive a GRN under their number. A CANCELLED
 *  PO never will; a DRAFT PO is reference-only (mirrors recomputeSoPicked's
 *  dead-PO set in mfg-purchase-orders.ts). */
const DEAD_PO_STATUSES = new Set(['CANCELLED', 'DRAFT']);

/** Resolve each SO line's EXPECTED batch (bound LIVE PO number + ETA). A line
 *  with no live bound PO is simply absent from the returned map (caller treats
 *  absence as "cannot drop-ship"). When a line is bound to >1 live PO:
 *    - onMultiPo 'latest' (movement-write paths): pick the most recently
 *      created live PO so the batch stays deterministic and matches the bucket
 *      the original OUT was stamped with;
 *    - onMultiPo 'block' (guard/offer paths): return the line with
 *      poNumber null + multiPo true so the caller blocks the drop-ship and
 *      can tell the operator WHY (audit H3).
 *
 *  `onMultiPo` IS REQUIRED, and that is the point. It arrived as
 *  `opts?: { onMultiPo?: ... }` defaulting to 'latest' — so H3, the hardening
 *  that exists to REFUSE an ambiguous batch, only applied to the call sites
 *  that opted in, and a new caller inherited the pre-H3 behaviour with no
 *  compile error and no failing test. 'latest' cannot be the silent default
 *  because it is the permissive direction: it stamps ONE of two possible PO
 *  numbers on the OUT while the GRN may arrive under the other, stranding the
 *  drop-ship COGS at 0 forever. Every caller now states which question it is
 *  asking, so the next hardening can enumerate them from the compiler
 *  (2026-08-13, optional-param-noop sweep — same shape as itemCode in
 *  scm/shared/so-variant-rule.ts).
 *
 *  Best-effort: any read error yields an empty map (every line treated as
 *  no-PO -> drop-ship blocked, safe). */
export async function resolveExpectedBatchBySoItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soItemIds: Array<string | null | undefined>,
  opts: { onMultiPo: 'latest' | 'block' },
): Promise<Map<string, ExpectedBatch>> {
  const onMultiPo = opts.onMultiPo;
  const out = new Map<string, ExpectedBatch>();
  const ids = [...new Set(soItemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;

  try {
    // PO items that came from these SO lines -> their PO ids (mig 0098 port).
    const { data: poiRows, error: poiErr } = await sb
      .from('purchase_order_items')
      .select('so_item_id, purchase_order_id, created_at')
      .in('so_item_id', ids)
      .not('purchase_order_id', 'is', null);
    if (poiErr) return out;
    const links = (poiRows ?? []) as Array<{
      so_item_id: string | null; purchase_order_id: string | null; created_at: string | null;
    }>;
    if (links.length === 0) return out;

    const poIds = [...new Set(links.map((r) => r.purchase_order_id).filter((x): x is string => !!x))];
    /* H1 — status joins the read so dead (CANCELLED / DRAFT) POs never satisfy
       the drop-ship guardrail. Filtered app-side so a schema without the
       status column can never silently widen the filter. */
    const { data: poRows, error: poErr } = await sb
      .from('purchase_orders')
      .select('id, po_number, status, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4')
      .in('id', poIds);
    if (poErr) return out;
    type PoRow = {
      id: string; po_number: string | null; status: string | null; expected_at: string | null;
      supplier_delivery_date_2: string | null; supplier_delivery_date_3: string | null; supplier_delivery_date_4: string | null;
    };
    const poById = new Map<string, PoRow>();
    for (const p of (poRows ?? []) as PoRow[]) {
      if (DEAD_PO_STATUSES.has((p.status ?? '').toUpperCase())) continue; // H1
      poById.set(p.id, p);
    }

    const effectiveEta = (p: PoRow): string | null => {
      const cands = [p.expected_at, p.supplier_delivery_date_2, p.supplier_delivery_date_3, p.supplier_delivery_date_4]
        .filter((d): d is string => !!d)
        .sort();
      return cands.length > 0 ? cands[cands.length - 1]! : null;
    };

    /* Per SO line: the set of LIVE bound POs, plus the most-recently-created
       one for the deterministic 'latest' pick. Links to dead POs are ignored
       entirely (H1). */
    const livePosByLine = new Map<string, Set<string>>();
    const bestLinkByLine = new Map<string, { poId: string; createdAt: string }>();
    for (const l of links) {
      if (!l.so_item_id || !l.purchase_order_id) continue;
      if (!poById.has(l.purchase_order_id)) continue; // dead or unknown PO
      const set = livePosByLine.get(l.so_item_id) ?? new Set<string>();
      set.add(l.purchase_order_id);
      livePosByLine.set(l.so_item_id, set);
      const cur = bestLinkByLine.get(l.so_item_id);
      const createdAt = l.created_at ?? '';
      if (!cur || createdAt > cur.createdAt) {
        bestLinkByLine.set(l.so_item_id, { poId: l.purchase_order_id, createdAt });
      }
    }
    for (const [soItemId, link] of bestLinkByLine) {
      const livePos = livePosByLine.get(soItemId) ?? new Set<string>();
      if (livePos.size > 1 && onMultiPo === 'block') {
        out.set(soItemId, { poNumber: null, eta: null, multiPo: true }); // H3
        continue;
      }
      const po = poById.get(link.poId);
      if (po?.po_number) out.set(soItemId, { poNumber: po.po_number, eta: effectiveEta(po) });
    }
  } catch {
    return out;
  }
  return out;
}

/** Build the drop-ship payload for a set of blocked sofa offenders: each
 *  offender enriched with its bound PO + ETA (null when no live PO, or when
 *  >1 live PO makes the batch ambiguous — `multiPo` then says why). Feeds
 *  sofaNoCompleteBatchResponse so the 409 carries enough to render the
 *  "Ship as drop-ship?" dialog (and to decide whether drop-ship is offerable). */
export async function buildDropshipOffenders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  offenders: Array<{ itemCode: string; soItemId: string | null }>,
): Promise<Array<{ itemCode: string; soItemId: string | null; poNumber: string | null; eta: string | null; multiPo?: boolean }>> {
  const expected = await resolveExpectedBatchBySoItem(
    sb, offenders.map((o) => o.soItemId), { onMultiPo: 'block' });
  return offenders.map((o) => {
    const eb = o.soItemId ? expected.get(o.soItemId) : undefined;
    return {
      itemCode: o.itemCode,
      soItemId: o.soItemId,
      poNumber: eb?.poNumber ?? null,
      eta: eb?.eta ?? null,
      ...(eb?.multiPo ? { multiPo: true } : {}),
    };
  });
}
