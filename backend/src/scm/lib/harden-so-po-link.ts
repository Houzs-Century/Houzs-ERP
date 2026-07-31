// ----------------------------------------------------------------------------
// harden-so-po-link — turn the SOFT MRP allocation into a HARD SO->PO binding at
// the moment a Sales Order becomes a Delivery Order.
//
// THE MODEL (owner, 2026-07-31). Every shortage — mattress, bedframe AND sofa —
// is allocated by MRP against the customer delivery-date list, and that
// allocation is deliberately SOFT: an urgent insert re-shuffles it by priority,
// which is the whole point. The PO screen shows which SO it is for and the SO
// screen shows which PO will supply it, both from that one floating allocation.
//
//   THE MOMENT AN SO BECOMES A DO, IT MUST TURN HARD.
//
// The DO knows exactly whose goods it is taking. It deducts stock, so in MRP the
// demand drops AND the supply must drop with it — the two cancel out. Shipping
// with nothing on hand is the same thing with the sign flipped: the shipment
// goes negative against that PO, the GRN offsets it, and MRP must never hand
// those units to a second Sales Order.
//
// WHY THIS MODULE HAD TO EXIST. resolveExpectedBatchBySoItem (dropship-batch.ts)
// resolves the incoming batch ONLY through purchase_order_items.so_item_id — it
// can USE a hard binding, it cannot CREATE one. So "bind the matched PO on
// ship-anyway" is a no-op on the common case, where the match is still soft.
// The missing step, and the point of the change, is to WRITE the allocation the
// SO screen is already showing.
//
// ONE SOURCE OF TRUTH, DELIBERATELY. The PO number comes from computeMrp /
// mrpLineCoverage — the SAME allocation the SO detail renders as `coverage_po`
// (mfg-sales-orders.ts) and the same one /po-so-coverage inverts. This module
// invents NO second matching rule: two rules that can disagree is the original
// bug (BUG-HISTORY 2026-07-31, "the guess no longer looks like a binding").
// All this decides is WHICH LINE of the PO that allocation already named gets
// the stamp.
//
// WHAT IT REFUSES. Hardening is only ever called for an SO line that currently
// resolves NO live bound PO, so it can never create the >1-live-PO ambiguity
// dropship-batch.ts H3 exists to block; the PO itself must be live (H1); and an
// existing so_item_id pointing at a DIFFERENT SO line is never overwritten.
// Every refusal is reported, never silent — the shipment then goes out unbound,
// exactly as it does today.
// ----------------------------------------------------------------------------

export type PoLineCandidate = {
  id: string;
  material_code: string | null;
  qty: number | null;
  received_qty: number | null;
  so_item_id: string | null;
  created_at: string | null;
};

export type HardenReason =
  /** Written: this PO line now carries so_item_id. */
  | 'hardened'
  /** Already pointed at this SO line — nothing to do, treat as bound. */
  | 'already_linked'
  /** No line on that PO orders this SKU (MRP matched a pooled variant bucket). */
  | 'no_matching_line'
  /** Every matching line is fully received — there is nothing incoming to bind. */
  | 'no_open_qty'
  /** Every matching open line is already promised to a DIFFERENT Sales Order. */
  | 'taken_by_other_so';

export type HardenPick = { poItemId: string | null; reason: HardenReason };

const codeEq = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = String(a ?? '').trim().toUpperCase();
  const y = String(b ?? '').trim().toUpperCase();
  return x !== '' && x === y;
};

const openQty = (l: PoLineCandidate): number => Number(l.qty ?? 0) - Number(l.received_qty ?? 0);

/** Choose which line of the MRP-named PO carries the binding. PURE.
 *
 *  ⚠ TWO FREE LINES OF THE SAME SKU ON ONE PO IS NOT AN AMBIGUITY WORTH
 *  REFUSING, and the distinction matters. The thing that must never be guessed
 *  is WHICH PO supplies the line, because the PO number IS the batch number
 *  (dropship-batch.ts) — pick the wrong one and the OUT is stamped with a batch
 *  the GRN will never arrive under, stranding the COGS at 0 forever. That
 *  choice is not made here: MRP already made it, and >1 live PO on one SO line
 *  is refused upstream by H3. Within ONE PO every candidate yields the SAME
 *  po_number, so the observable outcome is identical and a deterministic pick
 *  (oldest first, id as tiebreak) is correct rather than merely convenient. One
 *  PO legitimately carrying two lines of the same material is a real shape here
 *  — see BUG-HISTORY 2026-07-29 on the GRN unique-index refutation. */
export function pickPoLineToHarden(
  soItemId: string,
  itemCode: string,
  lines: PoLineCandidate[],
): HardenPick {
  const matching = lines.filter((l) => codeEq(l.material_code, itemCode));
  if (matching.length === 0) return { poItemId: null, reason: 'no_matching_line' };

  const mine = matching.find((l) => l.so_item_id === soItemId);
  if (mine) return { poItemId: mine.id, reason: 'already_linked' };

  const free = matching
    .filter((l) => l.so_item_id == null && openQty(l) > 0)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
  if (free.length > 0) return { poItemId: free[0]!.id, reason: 'hardened' };

  // Nothing free. Say WHICH wall was hit — the two need different human action.
  const unboundButClosed = matching.some((l) => l.so_item_id == null);
  return unboundButClosed
    ? { poItemId: null, reason: 'no_open_qty' }
    : { poItemId: null, reason: 'taken_by_other_so' };
}

export type SoftMatch = {
  soItemId: string;
  itemCode: string;
  /** The PO number MRP's allocation named for this line (= the batch number). */
  poNumber: string;
};

export type HardenOutcome = SoftMatch & {
  hardened: boolean;
  /** scm.purchase_orders.id — the audit target. null when the PO is not live. */
  poId: string | null;
  poItemId: string | null;
  reason: HardenReason | 'po_not_live';
};

/** PO statuses that can never receive a GRN, so a binding to one would be a
 *  batch that never arrives. Mirrors dropship-batch.ts H1 (imported there from
 *  the same constant so the two can not drift). */
export const DEAD_PO_STATUSES = new Set(['CANCELLED', 'DRAFT']);

/** Write the soft allocation as a hard binding.
 *
 *  IDEMPOTENT: a line already pointing at this SO line is reported
 *  `already_linked` and not rewritten. NEVER CLOBBERS: an so_item_id belonging
 *  to a different SO line is left exactly as it is and reported
 *  `taken_by_other_so` — the other order's claim is as real as this one's, and
 *  silently moving it would make a second document lie. The write is guarded by
 *  `.is('so_item_id', null)` so a concurrent bind loses the race rather than
 *  being overwritten.
 *
 *  BEST-EFFORT BY CONTRACT: a failure here means the shipment goes out unbound —
 *  today's behaviour — and must never block the delivery. The caller logs the
 *  outcomes and carries on. */
export async function hardenSoPoLinks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  matches: SoftMatch[],
  onAudit?: (o: HardenOutcome) => Promise<void> | void,
): Promise<HardenOutcome[]> {
  const out: HardenOutcome[] = [];
  if (matches.length === 0) return out;

  const poNumbers = [...new Set(matches.map((m) => m.poNumber).filter(Boolean))];
  const { data: poRows, error: poErr } = await sb
    .from('purchase_orders').select('id, po_number, status').in('po_number', poNumbers);
  if (poErr) return matches.map((m) => ({ ...m, hardened: false, poId: null, poItemId: null, reason: 'po_not_live' as const }));

  const liveIdByNumber = new Map<string, string>();
  for (const p of (poRows ?? []) as Array<{ id: string; po_number: string; status: string | null }>) {
    if (DEAD_PO_STATUSES.has((p.status ?? '').toUpperCase())) continue; // H1
    liveIdByNumber.set(p.po_number, p.id);
  }

  const livePoIds = [...new Set([...liveIdByNumber.values()])];
  const linesByPoId = new Map<string, PoLineCandidate[]>();
  if (livePoIds.length > 0) {
    const { data: lineRows } = await sb
      .from('purchase_order_items')
      .select('id, purchase_order_id, material_code, qty, received_qty, so_item_id, created_at')
      .in('purchase_order_id', livePoIds);
    for (const l of (lineRows ?? []) as Array<PoLineCandidate & { purchase_order_id: string }>) {
      const arr = linesByPoId.get(l.purchase_order_id) ?? [];
      arr.push(l);
      linesByPoId.set(l.purchase_order_id, arr);
    }
  }

  /* Sequential, not parallel: two lines of one DO can name the same PO, and the
     second must see the first's stamp so they cannot both claim one PO line. */
  for (const m of matches) {
    const poId = liveIdByNumber.get(m.poNumber);
    if (!poId) { out.push({ ...m, hardened: false, poId: null, poItemId: null, reason: 'po_not_live' }); continue; }
    const pick = pickPoLineToHarden(m.soItemId, m.itemCode, linesByPoId.get(poId) ?? []);
    if (pick.reason !== 'hardened' || !pick.poItemId) {
      out.push({ ...m, hardened: pick.reason === 'already_linked', poId, poItemId: pick.poItemId, reason: pick.reason });
      continue;
    }
    const { error: wErr } = await sb.from('purchase_order_items')
      .update({ so_item_id: m.soItemId })
      .eq('id', pick.poItemId)
      .is('so_item_id', null); // lose a concurrent bind rather than overwrite it
    if (wErr) {
      out.push({ ...m, hardened: false, poId, poItemId: pick.poItemId, reason: 'taken_by_other_so' });
      continue;
    }
    // Reflect the write locally so a later match in this same batch sees it.
    const local = (linesByPoId.get(poId) ?? []).find((l) => l.id === pick.poItemId);
    if (local) local.so_item_id = m.soItemId;
    const outcome: HardenOutcome = { ...m, hardened: true, poId, poItemId: pick.poItemId, reason: 'hardened' };
    out.push(outcome);
    if (onAudit) { try { await onAudit(outcome); } catch { /* audit is never a precondition */ } }
  }
  return out;
}
