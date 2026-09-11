// amendment-po-followup — auto-raise the PO Amendment(s) that FOLLOW a
// product-lane SO amendment (owner rework 2026-07-27, purchaser-side spec).
//
// THE MODEL. When purchasing approves the LINES lane of an SO amendment, the
// Sales Order is revised on the spot (applySoAmendment) — but the bound
// Purchase Order is NOT touched yet. Instead this module raises a follow-up
// row in the EXISTING PO Amendments module, linked back by
// source_so_amendment_id, and the purchaser confirms it there (their second
// signature). On that confirm, routes/po-amendments.ts calls reviseBoundPo —
// the battle-tested Approve-PO engine — scoped to that one PO, so the PO is
// re-derived from the SO's CURRENT truth at confirm time. The lines written
// here are therefore a PREVIEW for the reviewer (old_snapshot.preview = true),
// not the apply payload: the apply reads the Sales Order, never these rows.
//
// WHY a preview and not the payload: reviseBoundPo re-derives supplier COST
// from the revised spec and reconciles the whole line SET (adds / orphan
// removes / re-derives) with rules this module must not fork (received-floor,
// supplier matching, sofa notes — see so-revision.ts). Duplicating that
// derivation into po_amendment_lines would be a second copy that drifts.
//
// Bound-PO discovery mirrors reviseBoundPo steps (3)-(7) — the surviving
// lines' live links UNION the snapshot's frozen links for removed lines (the
// so_item_id FK is ON DELETE SET NULL, so the snapshot poLinks recorded at
// Approve-SO is the only durable record of a removed line's PO home).
//
// Runs INSIDE the approve-lines transaction (runScmPgCommand): the SO revision
// and its follow-up request commit or roll back together — there is no window
// where the SO changed but the purchaser's to-do vanished.

import type { Context } from 'hono';
import { isServiceLine } from '../shared/service-sku';
import { activeCompanyId, stampCompany } from './companyScope';

type Sb = any;

export type PoFollowUpResult = {
  followUps: Array<{ poId: string; poNumber: string; amendmentId: string; amendmentNo: string }>;
  /** Plain-language notes for the approver's toast + the SO audit trail. */
  warnings: string[];
};

type SoAmendLine = {
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
};

/* A line change the bound PO cares about. QTY / ADD / REMOVE always reshape the
   PO; a SPEC edit does when it changes WHAT the item is (code or variants) —
   a sell-price-only SPEC edit changes what the CUSTOMER pays, which the PO
   (supplier cost) does not carry. */
const poRelevant = (l: SoAmendLine): boolean => {
  const t = String(l.change_type ?? '').toUpperCase();
  if (t === 'ADD' || t === 'REMOVE' || t === 'QTY') return true;
  if (t === 'SPEC') return l.new_item_code != null || l.new_variants != null;
  return false;
};

/** The SO line a change targets, from the live row when it survived and from
 *  the pre-apply snapshot when it did not (a REMOVE hard-deletes the row). */
export type SoLineIdentity = { item_code?: string | null; item_group?: string | null };

/* SERVICE lines are not goods (shared/service-sku): storage, disposal and
   delivery charges ride the SO->DO->SI chain but never become MRP demand and
   never become a PO line, so a change to one has nothing for the supplier to
   follow. Owner 2026-09-09 — "SO amendment 如果是关于 Service (storage /
   disposal / delivery) 无需升级到 PO amendment": HC-SO-006772/A1 moved a
   storage charge from 7 to 10 months and still raised HC-PO-006690/A1 with
   ZERO changes, an empty second signature the purchaser had to clear by hand.

   Decided on the line's IDENTITY, both sides of the edit: an existing line is
   service-only when it was service BEFORE and (if the code moved) still is
   AFTER, so a SPEC edit that swaps a service SKU for real goods still
   escalates. Unknown identity is NOT service — an extra follow-up the
   purchaser withdraws beats a supplier never hearing about a real change. */
const serviceOnlyChange = (
  l: SoAmendLine,
  identityOf: (soItemId: string) => SoLineIdentity | undefined,
): boolean => {
  const base = l.sales_order_item_id ? identityOf(l.sales_order_item_id) : undefined;
  const before = base
    ? isServiceLine({ itemGroup: base.item_group ?? null, itemCode: base.item_code ?? null })
    : null;
  const after = l.new_item_code != null ? isServiceLine({ itemCode: l.new_item_code }) : null;
  if (before == null && after == null) return false;   // no identity to judge — escalate
  if (before == null) return after === true;           // ADD: the new code decides
  if (after == null) return before;                    // QTY / REMOVE / variant-only SPEC
  return before && after;
};

export async function raisePoFollowUps(
  sb: Sb,
  c: Context<any>,
  args: {
    soAmendmentId: string;
    soAmendmentNo: string;
    soDocNo: string;
    reason: string | null;
    /** scm.staff uuid of the approver — the follow-up is THEIR to-do. */
    requesterStaffId: string;
  },
): Promise<PoFollowUpResult> {
  const none: PoFollowUpResult = { followUps: [], warnings: [] };

  // (1) The amendment's own line changes — no PO-relevant change, no follow-up.
  const { data: lineRows, error: lineErr } = await sb.from('so_amendment_lines')
    .select('sales_order_item_id, change_type, new_item_code, new_variants, new_qty, new_unit_price_sen')
    .eq('amendment_id', args.soAmendmentId);
  if (lineErr) throw new Error(`raisePoFollowUps: amendment lines load failed: ${lineErr.message}`);
  const changedLines = ((lineRows ?? []) as SoAmendLine[]).filter(poRelevant);
  if (changedLines.length === 0) return none;

  // (2) The pre-apply snapshot (written by applySoAmendment moments ago in this
  //     same transaction) — previous line ids + the frozen SO→PO links.
  const { data: snapRow, error: snapErr } = await sb.from('so_revisions')
    .select('snapshot')
    .eq('amendment_id', args.soAmendmentId)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapErr) throw new Error(`raisePoFollowUps: snapshot load failed: ${snapErr.message}`);
  const snap = (snapRow as { snapshot?: { lines?: Array<{ id?: string }>; poLinks?: Record<string, string[]> } } | null)?.snapshot ?? null;
  const prevLineIds = new Set(((snap?.lines ?? []) as Array<{ id?: string }>)
    .map((r) => String(r.id ?? '')).filter((x) => x.length > 0));
  const poLinks = (snap?.poLinks ?? {}) as Record<string, string[]>;

  // (3) Current (post-apply) SO line ids → live PO links for surviving lines.
  /* CANCELLED IS REMOVED. `removed = prevLineIds \ currentIdSet` is what
     orphans the PO line a since-deleted SO line was bound to, and it is the
     only warning the supplier side ever gets. A retained cancelled row would
     stay in currentIdSet forever, so the customer's cancellation would never
     reach the supplier and the factory would keep building the item. The hard
     delete gives this for free today; the filter is what keeps it true once a
     removal becomes a soft cancel. Filtered in JS rather than SQL so a NULL —
     which the column default forbids but a partial row shape does not — reads
     as LIVE, never as removed. */
  const { data: soItemRows, error: soItemErr } = await sb.from('mfg_sales_order_items')
    .select('id, cancelled, item_code, item_group').eq('doc_no', args.soDocNo);
  if (soItemErr) throw new Error(`raisePoFollowUps: SO items load failed: ${soItemErr.message}`);
  const soItemRowsTyped = (soItemRows ?? []) as Array<{ id: string; cancelled?: boolean | null } & SoLineIdentity>;
  const soItemIds = soItemRowsTyped.filter((r) => r.cancelled !== true).map((r) => r.id);
  const currentIdSet = new Set(soItemIds);

  /* (3b) Drop the SERVICE-only changes. A removed line is gone from
     mfg_sales_order_items, so its identity comes from the snapshot frozen a
     moment ago. Nothing PO-relevant left = nothing for purchasing to sign. */
  const identityById = new Map<string, SoLineIdentity>();
  for (const r of ((snap?.lines ?? []) as Array<{ id?: string } & SoLineIdentity>)) {
    if (r.id) identityById.set(String(r.id), { item_code: r.item_code, item_group: r.item_group });
  }
  for (const r of soItemRowsTyped) identityById.set(r.id, { item_code: r.item_code, item_group: r.item_group });
  const soLines = changedLines.filter((l) => !serviceOnlyChange(l, (id) => identityById.get(id)));
  if (soLines.length === 0) return none;

  type PoItem = {
    id: string; purchase_order_id: string | null; so_item_id: string | null;
    item_code: string | null; material_name: string | null;
    // The full "before" the reviewer's preview diff renders against. Without the
    // spec fields (qty / variants / item_group / description2) the PO-amendment
    // card could not show what a SPEC change actually moved, and an unrecorded
    // old qty rendered as a phantom "Qty - -> N" (docs/bugs).
    qty: number | null; unit_price_sen: number | null; delivery_date: string | null;
    variants: unknown; item_group: string | null; description2: string | null;
  };
  const PO_ITEM_COLS =
    'id, purchase_order_id, so_item_id, item_code, material_name, ' +
    'qty, unit_price_sen, delivery_date, variants, item_group, description2';
  let livePoItems: PoItem[] = [];
  if (soItemIds.length > 0) {
    const { data: poItemRows, error: poItemErr } = await sb.from('purchase_order_items')
      .select(PO_ITEM_COLS)
      .in('so_item_id', soItemIds);
    if (poItemErr) throw new Error(`raisePoFollowUps: PO items load failed: ${poItemErr.message}`);
    livePoItems = (poItemRows ?? []) as PoItem[];
  }

  // (4) Orphaned PO lines — removed SO lines' frozen links, read fresh.
  const removedSoItemIds = [...prevLineIds].filter((id) => !currentIdSet.has(id));
  const orphanPoItemIds = [...new Set(removedSoItemIds.flatMap((id) => poLinks[id] ?? []))];
  let orphanItems: PoItem[] = [];
  if (orphanPoItemIds.length > 0) {
    const { data: oRows, error: oErr } = await sb.from('purchase_order_items')
      .select(PO_ITEM_COLS)
      .in('id', orphanPoItemIds);
    if (oErr) throw new Error(`raisePoFollowUps: orphan PO lines load failed: ${oErr.message}`);
    orphanItems = (oRows ?? []) as PoItem[];
  }

  /* (5) Candidate POs = the POs that actually HOST a changed line — its live
     link, or its frozen orphan home when the change removed it — minus
     CANCELLED. Owner 2026-09-09: this used to be EVERY PO bound to the SO, so
     a one-line change on a multi-PO order raised a 0-change amendment against
     each untouched PO as well. Confirming one was harmless (reviseBoundPo
     re-derives that PO from the SO and finds nothing to change) but it is a
     signature the purchaser had to clear for nothing.

     NARROWING ONLY APPLIES WHEN EVERY CHANGED LINE ALREADY HAS A PO HOME. A
     changed line that has none may still NEED one — an ADD by construction (a
     brand-new SO line has no link yet), and equally an existing line that was
     never on a PO, including one a SPEC edit just turned from a service SKU
     into real goods. For those the full bound set stays in play and the supplier
     matching happens at confirm, in reviseBoundPo, exactly as before; narrowing
     them away would mean new goods never reach a supplier. */
  const changedSoItemIds = new Set(soLines
    .map((l) => l.sales_order_item_id).filter((x): x is string => Boolean(x)));
  const linkedSoItemIds = new Set(livePoItems
    .map((r) => r.so_item_id).filter((x): x is string => Boolean(x)));
  const needsHome = soLines.some((l) =>
    String(l.change_type).toUpperCase() === 'ADD'
    || !(l.sales_order_item_id && linkedSoItemIds.has(l.sales_order_item_id)));

  const boundPoIds = [...new Set([
    ...livePoItems.map((r) => r.purchase_order_id),
    ...orphanItems.map((r) => r.purchase_order_id),
  ].filter((x): x is string => Boolean(x)))];
  const orphanIdsForChanged = new Set(removedSoItemIds
    .filter((id) => changedSoItemIds.has(id)).flatMap((id) => poLinks[id] ?? []));
  const touchedPoIds = new Set<string>();
  for (const r of livePoItems) {
    if (r.purchase_order_id && r.so_item_id && changedSoItemIds.has(r.so_item_id)) touchedPoIds.add(r.purchase_order_id);
  }
  for (const r of orphanItems) {
    if (r.purchase_order_id && orphanIdsForChanged.has(r.id)) touchedPoIds.add(r.purchase_order_id);
  }
  /* When narrowing applies, touchedPoIds cannot be empty: every changed line
     has a live link, so at least one PO hosts one. */
  const candidatePoIds = needsHome ? boundPoIds : [...touchedPoIds];
  if (candidatePoIds.length === 0) {
    return { followUps: [], warnings: ['No purchase order is bound to this Sales Order yet, so there is nothing to revise on the purchasing side.'] };
  }
  const { data: poHeaderRows, error: poHeadErr } = await sb.from('purchase_orders')
    .select('id, po_number, status')
    .in('id', candidatePoIds);
  if (poHeadErr) throw new Error(`raisePoFollowUps: PO headers load failed: ${poHeadErr.message}`);
  const livePos = ((poHeaderRows ?? []) as Array<{ id: string; po_number: string; status: string }>)
    .filter((p) => String(p.status).toUpperCase() !== 'CANCELLED');
  if (livePos.length === 0) {
    return { followUps: [], warnings: ['Every purchase order bound to this Sales Order is cancelled — raise a fresh PO for the revised lines.'] };
  }

  const warnings: string[] = [];
  const followUps: PoFollowUpResult['followUps'] = [];

  const poItemsByPo = new Map<string, PoItem[]>();
  for (const pi of [...livePoItems, ...orphanItems]) {
    if (!pi.purchase_order_id) continue;
    const arr = poItemsByPo.get(pi.purchase_order_id) ?? [];
    arr.push(pi);
    poItemsByPo.set(pi.purchase_order_id, arr);
  }

  /* The PO line's CURRENT state, the "before" the reviewer's diff renders
     against. Carries the spec fields (variants / item_group / description2) so
     the card can show what a SPEC change moved -- the SO-amendment card reads the
     same shape (so-amendment-line-diff.ts: variants + item_group + description2).
     preview:true marks these rows advisory: the confirm re-derives from the SO. */
  const beforeSnapshot = (item: PoItem) => ({
    preview: true as const,
    source_so_amendment_no: args.soAmendmentNo,
    item_code: item.item_code,
    material_name: item.material_name,
    qty: item.qty,
    unit_price_sen: item.unit_price_sen,
    delivery_date: item.delivery_date,
    variants: item.variants,
    item_group: item.item_group,
    description2: item.description2,
  });

  for (const po of livePos) {
    // (6) One OPEN request per PO — the module's own rule. An open follow-up
    //     already covers this PO (its confirm re-reads the SO's CURRENT truth);
    //     an open MANUAL request must not be silently displaced.
    const { data: priorRows, error: priorErr } = await sb.from('po_amendments')
      .select('id, status, source_so_amendment_id, source_so_amendment_no')
      .eq('po_id', po.id);
    if (priorErr) throw new Error(`raisePoFollowUps: prior amendments load failed: ${priorErr.message}`);
    const prior = (priorRows ?? []) as Array<{ id: string; status: string; source_so_amendment_id: string | null; source_so_amendment_no: string | null }>;
    const open = prior.find((a) => a.status === 'REQUESTED');
    if (open) {
      if (open.source_so_amendment_id) {
        warnings.push(`${po.po_number} already has follow-up ${open.source_so_amendment_no ?? ''} awaiting confirmation — confirming it will pick up this amendment's changes too.`.replace('  ', ' '));
      } else {
        warnings.push(`${po.po_number} has a manual PO amendment still open — resolve it, then raise the PO revision for this change by hand.`);
      }
      continue;
    }

    const amendmentNo = `${po.po_number}/A${prior.length + 1}`;

    const { data: created, error: insErr } = await sb.from('po_amendments').insert({
      po_id:        po.id,
      po_number:    po.po_number,
      amendment_no: amendmentNo,
      status:       'REQUESTED',
      reason:       `Auto-raised from SO amendment ${args.soAmendmentNo}${args.reason ? ` — ${args.reason}` : ''}. Confirming applies the revised Sales Order to this PO.`,
      requested_by: args.requesterStaffId,
      company_id:   activeCompanyId(c),
      source_so_amendment_id: args.soAmendmentId,
      source_so_amendment_no: args.soAmendmentNo,
    }).select('id').single();
    if (insErr) {
      // The partial unique index raced us — treat exactly like the open-row case.
      if (/uq_po_amendment_open|duplicate key/i.test(insErr.message)) {
        warnings.push(`${po.po_number} already has an open amendment — it will carry this change when confirmed.`);
        continue;
      }
      throw new Error(`raisePoFollowUps: insert failed for ${po.po_number}: ${insErr.message}`);
    }
    const amendmentId = (created as { id: string }).id;

    /* (7) PREVIEW lines — what the reviewer sees. The confirm re-derives from
       the Sales Order, so these rows are labelled preview and carry the target
       line's identity + the requested change, never a computed cost. */
    const itemsHere = poItemsByPo.get(po.id) ?? [];
    const bySoItemId = new Map(itemsHere.filter((i) => i.so_item_id).map((i) => [i.so_item_id as string, i]));
    const previewRows: Array<Record<string, unknown>> = [];
    for (const l of soLines) {
      const t = String(l.change_type).toUpperCase();
      if (t === 'ADD') {
        // Supplier matching happens at confirm (reviseBoundPo); attach the ADD
        // preview only in the unambiguous single-PO case.
        if (livePos.length === 1) {
          previewRows.push({
            amendment_id: amendmentId,
            purchase_order_item_id: null,
            change_type: 'ADD',
            new_item_code: l.new_item_code,
            new_variants: l.new_variants ?? null,
            new_qty: l.new_qty,
            old_snapshot: { preview: true, source_so_amendment_no: args.soAmendmentNo },
          });
        }
        continue;
      }
      if (t === 'REMOVE') {
        const linkIds = l.sales_order_item_id ? (poLinks[l.sales_order_item_id] ?? []) : [];
        for (const poItemId of linkIds) {
          const item = itemsHere.find((i) => i.id === poItemId);
          if (!item) continue;
          previewRows.push({
            amendment_id: amendmentId,
            purchase_order_item_id: poItemId,
            change_type: 'REMOVE',
            old_snapshot: beforeSnapshot(item),
          });
        }
        continue;
      }
      // QTY / SPEC on a surviving line — only if its bound line lives on THIS PO.
      const item = l.sales_order_item_id ? bySoItemId.get(l.sales_order_item_id) : undefined;
      if (!item) continue;
      previewRows.push({
        amendment_id: amendmentId,
        purchase_order_item_id: item.id,
        change_type: t === 'QTY' ? 'QTY' : 'SPEC',
        new_item_code: l.new_item_code,
        new_variants: l.new_variants ?? null,
        // Only a QTY change moves the qty. Carrying the unchanged qty on a SPEC
        // row made the preview render a phantom "Qty - -> N" and misroute the
        // change as Quantity (docs/bugs).
        new_qty: t === 'QTY' ? l.new_qty : null,
        old_snapshot: beforeSnapshot(item),
      });
    }
    if (previewRows.length > 0) {
      const { error: pErr } = await sb.from('po_amendment_lines').insert(stampCompany(previewRows, c));
      if (pErr) throw new Error(`raisePoFollowUps: preview lines insert failed for ${po.po_number}: ${pErr.message}`);
    }

    followUps.push({ poId: po.id, poNumber: po.po_number, amendmentId, amendmentNo });
  }

  return { followUps, warnings };
}
