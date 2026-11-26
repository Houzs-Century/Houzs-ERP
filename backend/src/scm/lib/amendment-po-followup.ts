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
import { catalogCategoriesByCode } from './validate-item-codes';
import { pickAddLineBinding, readMfgProductBindings } from './supplier-bindings';

type Sb = any;

export type PoFollowUpResult = {
  followUps: Array<{ poId: string; poNumber: string; amendmentId: string; amendmentNo: string }>;
  warnings: string[];
};

export type SoAmendLine = {
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
};

export const poRelevant = (l: SoAmendLine): boolean => {
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
   purchaser withdraws beats a supplier never hearing about a real change.

   The AFTER side reads the new code's CATALOGUE category as well as the code:
   an ADD of a bare service code (TRANSPORTATION CHARGES on HC-SO-012757/A1)
   has no SVC- prefix and no row, so by code alone it read as goods and would
   have raised an amendment against every PO bound to the order
   (docs/bugs/0895-an-amendment-that-added-a-service-line-went-to-the-purchaser.md). */
export const serviceOnlyChange = (
  l: SoAmendLine,
  identityOf: (soItemId: string) => SoLineIdentity | undefined,
  categoryOf: (itemCode: string) => string | null,
): boolean => {
  const base = l.sales_order_item_id ? identityOf(l.sales_order_item_id) : undefined;
  const before = base
    ? isServiceLine({ itemGroup: base.item_group ?? null, itemCode: base.item_code ?? null })
    : null;
  const after = l.new_item_code != null
    ? isServiceLine({ itemCode: l.new_item_code, category: categoryOf(l.new_item_code) })
    : null;
  if (before == null && after == null) return false;
  if (before == null) return after === true;
  if (after == null) return before;
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
    requesterStaffId: string;
  },
): Promise<PoFollowUpResult> {
  const none: PoFollowUpResult = { followUps: [], warnings: [] };

  const { data: lineRows, error: lineErr } = await sb.from('so_amendment_lines')
    .select('sales_order_item_id, change_type, new_item_code, new_variants, new_qty, new_unit_price_sen')
    .eq('amendment_id', args.soAmendmentId);
  if (lineErr) throw new Error(`raisePoFollowUps: amendment lines load failed: ${lineErr.message}`);
  const changedLines = ((lineRows ?? []) as SoAmendLine[]).filter(poRelevant);
  if (changedLines.length === 0) return none;

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

  const { data: soItemRows, error: soItemErr } = await sb.from('mfg_sales_order_items')
    .select('id, cancelled, item_code, item_group').eq('doc_no', args.soDocNo);
  if (soItemErr) throw new Error(`raisePoFollowUps: SO items load failed: ${soItemErr.message}`);
  const soItemRowsTyped = (soItemRows ?? []) as Array<{ id: string; cancelled?: boolean | null } & SoLineIdentity>;
  const soItemIds = soItemRowsTyped.filter((r) => r.cancelled !== true).map((r) => r.id);
  const currentIdSet = new Set(soItemIds);

  const identityById = new Map<string, SoLineIdentity>();
  for (const r of ((snap?.lines ?? []) as Array<{ id?: string } & SoLineIdentity>)) {
    if (r.id) identityById.set(String(r.id), { item_code: r.item_code, item_group: r.item_group });
  }
  for (const r of soItemRowsTyped) identityById.set(r.id, { item_code: r.item_code, item_group: r.item_group });
  const categoryByCode = await catalogCategoriesByCode(sb, changedLines.map((l) => l.new_item_code), activeCompanyId(c));
  if (!categoryByCode) throw new Error('raisePoFollowUps: catalogue categories load failed');
  const soLines = changedLines.filter((l) => !serviceOnlyChange(
    l, (id) => identityById.get(id), (code) => categoryByCode.get(code.trim()) ?? null,
  ));
  if (soLines.length === 0) return none;

  type PoItem = {
    id: string; purchase_order_id: string | null; so_item_id: string | null;
    item_code: string | null; material_name: string | null;
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
     each untouched PO as well.

     Plus, for a brand-new ADD, the bound PO(s) whose supplier can actually MAKE
     it — the SAME supplier pick reviseBoundPo applies at confirm
     (so-revision.ts (10)), pulled forward. Owner 2026-09-20: a sales-side "swap 1
     mattress to Equinox" added the mattress (supplier DIGLANT) as a revision onto
     a bedframe PO (supplier OHANA); confirming it would bump that PO's printed _R
     for nothing — reviseBoundPo can place the mattress on no OHANA line — while
     the real DIGLANT order went unraised. An ADD whose supplier serves no bound PO
     is now WARNED (raise a separate PO), never forced onto the wrong one. A
     changed EXISTING line with no live PO home is likewise not fanned out: it
     produced only empty follow-ups, because reviseBoundPo re-applies a line only
     when its id is NEW, so a pre-existing homeless line is never placed at
     confirm. */
  const changedSoItemIds = new Set(soLines
    .map((l) => l.sales_order_item_id).filter((x): x is string => Boolean(x)));
  const linkedSoItemIds = new Set(livePoItems
    .map((r) => r.so_item_id).filter((x): x is string => Boolean(x)));

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

  if (boundPoIds.length === 0) {
    return { followUps: [], warnings: ['No purchase order is bound to this Sales Order yet, so there is nothing to revise on the purchasing side.'] };
  }
  const { data: poHeaderRows, error: poHeadErr } = await sb.from('purchase_orders')
    .select('id, po_number, status, supplier_id')
    .in('id', boundPoIds);
  if (poHeadErr) throw new Error(`raisePoFollowUps: PO headers load failed: ${poHeadErr.message}`);
  const boundPos = ((poHeaderRows ?? []) as Array<{ id: string; po_number: string; status: string; supplier_id: string | null }>)
    .filter((p) => String(p.status).toUpperCase() !== 'CANCELLED');
  if (boundPos.length === 0) {
    return { followUps: [], warnings: ['Every purchase order bound to this Sales Order is cancelled — raise a fresh PO for the revised lines.'] };
  }

  const warnings: string[] = [];
  const followUps: PoFollowUpResult['followUps'] = [];

  const isAdd = (l: SoAmendLine) => String(l.change_type).toUpperCase() === 'ADD';
  const isHomeless = (l: SoAmendLine) =>
    isAdd(l) || !(l.sales_order_item_id && linkedSoItemIds.has(l.sales_order_item_id));
  const codeOf = (l: SoAmendLine): string =>
    (l.new_item_code
      ?? (l.sales_order_item_id ? identityById.get(l.sales_order_item_id)?.item_code : null)
      ?? '').trim();
  const homelessLines = soLines.filter(isHomeless);
  const supplierByCode = new Map<string, string>();
  const bindingsByCode = new Map<string, Array<{ item_code: string; supplier_id: string }>>();
  const homelessCodes = [...new Set(homelessLines.map(codeOf).filter((code) => code.length > 0))];
  if (homelessCodes.length > 0) {
    const { data: bRows, error: bErr } = await readMfgProductBindings<{ item_code: string; supplier_id: string }>(
      sb, { codes: homelessCodes, companyId: activeCompanyId(c), select: 'item_code, supplier_id, is_main_supplier' });
    if (bErr) throw new Error(`raisePoFollowUps: added-line supplier binding load failed: ${bErr.message}`);
    for (const b of bRows) {
      if (!supplierByCode.has(b.item_code)) supplierByCode.set(b.item_code, b.supplier_id);
      const arr = bindingsByCode.get(b.item_code) ?? [];
      arr.push(b);
      bindingsByCode.set(b.item_code, arr);
    }
  }

  const boundSupplierIds = new Set(boundPos.map((p) => p.supplier_id).filter((x): x is string => Boolean(x)));
  const addSupplierByCode = new Map<string, string>();
  for (const l of soLines.filter(isAdd)) {
    const code = codeOf(l);
    const picked = pickAddLineBinding(bindingsByCode.get(code) ?? [], boundSupplierIds);
    if (picked) {
      addSupplierByCode.set(code, picked.supplier_id);
    } else if (!supplierByCode.get(code)) {
      warnings.push(`${code || 'A new line'} has no main supplier set, so it cannot join a purchase order — set its supplier, then raise a PO for it.`);
    } else {
      warnings.push(`${code} is from a supplier with no open purchase order on this Sales Order — raise a separate PO for it.`);
    }
  }
  const addSupplierIds = new Set(addSupplierByCode.values());
  const supplierMatchedPoIds = new Set(boundPos
    .filter((p) => p.supplier_id && addSupplierIds.has(p.supplier_id)).map((p) => p.id));
  for (const hl of homelessLines.filter((l) => !isAdd(l))) {
    const code = codeOf(hl);
    if (code && supplierByCode.get(code)) {
      warnings.push(`${code} is not on an open purchase order, so its change could not be forwarded — raise a purchase order for it if needed.`);
    }
  }

  const candidateIdSet = new Set<string>([...touchedPoIds, ...supplierMatchedPoIds]);
  const livePos = boundPos.filter((p) => candidateIdSet.has(p.id));
  if (livePos.length === 0) {
    return { followUps: [], warnings };
  }

  const poItemsByPo = new Map<string, PoItem[]>();
  for (const pi of [...livePoItems, ...orphanItems]) {
    if (!pi.purchase_order_id) continue;
    const arr = poItemsByPo.get(pi.purchase_order_id) ?? [];
    arr.push(pi);
    poItemsByPo.set(pi.purchase_order_id, arr);
  }

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
      if (/uq_po_amendment_open|duplicate key/i.test(insErr.message)) {
        warnings.push(`${po.po_number} already has an open amendment — it will carry this change when confirmed.`);
        continue;
      }
      throw new Error(`raisePoFollowUps: insert failed for ${po.po_number}: ${insErr.message}`);
    }
    const amendmentId = (created as { id: string }).id;

    const itemsHere = poItemsByPo.get(po.id) ?? [];
    const bySoItemId = new Map(itemsHere.filter((i) => i.so_item_id).map((i) => [i.so_item_id as string, i]));
    const previewRows: Array<Record<string, unknown>> = [];
    for (const l of soLines) {
      const t = String(l.change_type).toUpperCase();
      if (t === 'ADD') {
        const addSupplier = addSupplierByCode.get(codeOf(l));
        if (addSupplier && po.supplier_id === addSupplier) {
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
      const item = l.sales_order_item_id ? bySoItemId.get(l.sales_order_item_id) : undefined;
      if (!item) continue;
      previewRows.push({
        amendment_id: amendmentId,
        purchase_order_item_id: item.id,
        change_type: t === 'QTY' ? 'QTY' : 'SPEC',
        new_item_code: l.new_item_code,
        new_variants: l.new_variants ?? null,
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
