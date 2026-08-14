// ─────────────────────────────────────────────────────────────────────────
// recost.ts — Costing B (Commander 2026-06-01): retroactive FIFO recost engine.
//
// THE PROBLEM IT SOLVES
//   When goods are received (GRN) the FIFO trigger books a lot at the GR price
//   (or 0 if the GR had no price — "Pending"). When that stock later ships on a
//   DO, the trigger consumes the lot and writes the REAL COGS onto the OUT
//   movement (inventory_movements.total_cost_sen) + the consumption row
//   (inventory_lot_consumptions). restampDoActualCost then copies that actual
//   cost onto the DO line (and the Sales Invoice copies the DO).
//
//   But the authoritative cost only arrives LATER, when the supplier's Purchase
//   Invoice is entered — or it gets CORRECTED (human error) by editing the PI or
//   the GR price. The lots, consumptions, movements, DO and SI were all booked
//   at the OLD (or zero) cost and are now wrong.
//
// WHAT THIS DOES (pure backend data updates via the service-role client — NO
// schema migration, the API already runs as SUPABASE_SERVICE_ROLE_KEY):
//   Given a GRN, re-derive the authoritative unit cost per received bucket
//   (PI price > GR price > Pending), then cascade it forward:
//     1. inventory_lots.unit_cost_sen           (the carrying cost)
//     2. the GRN IN movement's unit/total cost  (the lot's source movement)
//     3. inventory_lot_consumptions             (real COGS rows for every OUT)
//     4. the consuming OUT movements' total/unit cost
//     5. restampDoActualCost(DO)                (re-stamp every affected DO line)
//     6. restampSiFromDo(DO)                    (re-copy DO cost onto its SIs)
//
//   The result: a PI entered/edited (or a GR price corrected) AFTER the goods
//   shipped flows all the way down to the DO + Sales Invoice margin in real time.
//
// COST PRIORITY (per line): live (non-cancelled) Purchase Invoice line price,
// else the GR price, else Pending (lot left untouched — cost unknown until a
// price lands; Stage A surfaces this as "Pending"). Each step needs a POSITIVE
// price: 0 encodes "no price known" everywhere else in this schema (the FIFO
// trigger COALESCEs a missing IN cost to 0), so a zero-priced PI line falls
// through to the GR price rather than zeroing a lot that cost real money.
//
// Costs resolve per GRN LINE and are then aggregated onto the lot that line
// produced, identified by (product_code, variant_key, batch_no = source PO).
// Lines that remain tied there are indistinguishable to FIFO too, so they
// resolve to a qty-weighted average — Σ(qty × cost) is conserved exactly.
//
// Best-effort throughout: never throws into the caller (audit-DLQ pattern,
// same as the rest of the inventory layer). The primary write already
// committed; a recost hiccup logs + skips and self-heals on the next touch.
// ─────────────────────────────────────────────────────────────────────────

import { computeVariantKey } from '../shared';
import { restampDoActualCost } from '../routes/delivery-orders-mfg';
import { toMyrSen } from './fx';

/* Re-derive a Sales Invoice header's per-category revenue/cost totals from its
   line items. Mirror of the SI route's recomputeTotals (kept in lockstep).
   Fails CLOSED on a failed read and never throws — the same contract as the
   route's copy, and as the SO's recomputeTotals which carries the full
   rationale. See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputeSiTotals(sb: any, salesInvoiceId: string) {
  const { data: items, error: itemsErr } = await sb.from('sales_invoice_items')
    .select('item_group, line_total_centi, line_cost_centi')
    .eq('sales_invoice_id', salesInvoiceId);
  /* A failed READ is not an empty invoice, and `?? []` cannot tell them apart —
     it folded a transient blip into a ZERO total_centi (the column the GL posts
     from) on an invoice whose lines were intact. The ERROR is the signal, never
     the emptiness: a genuinely empty invoice resolves error === null with
     data === [] and MUST still fall through to zero the header. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[recost-si] item read failed — header left unchanged:', salesInvoiceId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_centi: number | null; line_cost_centi: number | null }>) {
    const lineTotal = Number(it.line_total_centi ?? 0);
    const lineCost = Number(it.line_cost_centi ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('sales_invoices').update({
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi: bedframeCost,
    accessories_cost_centi: accessoriesCost,
    others_cost_centi: othersCost,
    local_total_centi: total,
    total_cost_centi: totalCost,
    total_margin_centi: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    subtotal_centi: total,
    total_centi: total,
    updated_at: new Date().toISOString(),
  }).eq('id', salesInvoiceId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[recost-si] header update failed — totals left STALE:', salesInvoiceId, updErr.message);
  }
}

/* Re-copy a DO's (now actual) line costs onto every non-cancelled Sales Invoice
   line that bills it. SI lines link to DO lines via sales_invoice_items.
   do_item_id (migration 0103). Mirrors the DO→SI cost copy in the SI route's
   convert-from-DO, but as an in-place re-stamp. */
export async function restampSiFromDo(sb: any, deliveryOrderId: string) {
  try {
    const { data: doItems } = await sb.from('delivery_order_items')
      .select('id, unit_cost_centi')
      .eq('delivery_order_id', deliveryOrderId);
    if (!doItems || doItems.length === 0) return;
    const costByDoItem = new Map<string, number>();
    const doItemIds: string[] = [];
    for (const d of doItems as Array<{ id: string; unit_cost_centi: number | null }>) {
      costByDoItem.set(d.id, Number(d.unit_cost_centi ?? 0));
      doItemIds.push(d.id);
    }
    if (doItemIds.length === 0) return;

    const { data: siLines } = await sb.from('sales_invoice_items')
      .select('id, sales_invoice_id, do_item_id, qty, line_total_centi')
      .in('do_item_id', doItemIds);
    if (!siLines || siLines.length === 0) return;

    // Skip lines on cancelled invoices.
    const siIds = [...new Set((siLines as Array<{ sales_invoice_id: string }>).map((s) => s.sales_invoice_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (siIds.length > 0) {
      const { data: heads, error: headsErr } = await sb.from('sales_invoices').select('id, status').in('id', siIds);
      /* `?? []` folds a failed read into an EMPTY cancelled-set, which does not
         read as "we don't know" — it reads as "no invoice here is cancelled", and
         the loop below then re-stamps costs onto the lines of CANCELLED invoices
         and recomputes their totals. The two reads above return early on a null
         result, so a blip there merely skips the restamp; this one silently
         inverts a skip-guard. Abort instead: nothing is written until the loop
         below, so the invoices simply keep the costs they already had. */
      if (headsErr) {
        /* eslint-disable-next-line no-console */
        console.error('[restampSiFromDo] invoice status read failed — SI costs left unchanged:', deliveryOrderId, headsErr.message);
        return;
      }
      for (const h of (heads ?? []) as Array<{ id: string; status: string }>) {
        if ((h.status ?? '').toUpperCase() === 'CANCELLED') cancelled.add(h.id);
      }
    }

    const touched = new Set<string>();
    for (const s of siLines as Array<{ id: string; sales_invoice_id: string; do_item_id: string | null; qty: number; line_total_centi: number | null }>) {
      if (cancelled.has(s.sales_invoice_id)) continue;
      if (!s.do_item_id) continue;
      const unitCost = costByDoItem.get(s.do_item_id);
      if (unitCost === undefined) continue;
      const qty = Number(s.qty ?? 0);
      const lineCost = unitCost * qty;
      const lineTotal = Number(s.line_total_centi ?? 0);
      await sb.from('sales_invoice_items').update({
        unit_cost_centi: unitCost,
        line_cost_centi: lineCost,
        line_margin_centi: lineTotal - lineCost,
      }).eq('id', s.id);
      touched.add(s.sales_invoice_id);
    }
    for (const siId of touched) await recomputeSiTotals(sb, siId);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[restampSiFromDo] failed:', deliveryOrderId, e); }
}

/* Each GRN line's source PO number — the SAME value the GRN post stamped onto
   its IN movement as batch_no (migration 0120), so it re-identifies the lot a
   line produced. Re-derived here (rather than imported from routes/grns, which
   already imports recostFromGrn) to keep this lib free of a routes cycle.
   Lines with no PO (manual / free GRN) are absent → batch '' , matching the
   NULL batch_no the post wrote. */
async function poNumberByGrnItem(
  sb: any,
  giList: Array<{ id: string; purchase_order_item_id: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const poItemIds = [...new Set(giList.map((g) => g.purchase_order_item_id).filter((x): x is string => !!x))];
  if (poItemIds.length === 0) return out;
  const { data: poi } = await sb.from('purchase_order_items')
    .select('id, purchase_order_id').in('id', poItemIds);
  const poiRows = (poi ?? []) as Array<{ id: string; purchase_order_id: string | null }>;
  const poIds = [...new Set(poiRows.map((r) => r.purchase_order_id).filter((x): x is string => !!x))];
  if (poIds.length === 0) return out;
  const { data: pos } = await sb.from('purchase_orders').select('id, po_number').in('id', poIds);
  const noByPo = new Map<string, string>();
  for (const p of (pos ?? []) as Array<{ id: string; po_number: string }>) noByPo.set(p.id, p.po_number);
  const noByPoItem = new Map<string, string>();
  for (const r of poiRows) {
    const n = r.purchase_order_id ? noByPo.get(r.purchase_order_id) : undefined;
    if (n) noByPoItem.set(r.id, n);
  }
  for (const g of giList) {
    const n = g.purchase_order_item_id ? noByPoItem.get(g.purchase_order_item_id) : undefined;
    if (n) out.set(g.id, n);
  }
  return out;
}

/* ── recostFromGrn — the engine ───────────────────────────────────────────
   Re-derive authoritative cost for one GRN's received buckets and cascade it
   to lots → consumptions → movements → DO → SI. Idempotent (a bucket whose lot
   already carries the authoritative cost is skipped). Best-effort. */
export async function recostFromGrn(sb: any, grnId: string) {
  try {
    // 1. GRN lines — the received buckets + their GR (fallback) price.
    //    Migration 0082 — also read allocated_charge_centi + qty_accepted so the
    //    landed FREIGHT folded in at receive time survives a PI recost.
    //    ORDER BY id: the resolution below is order-independent by construction,
    //    but an unordered select made two runs over identical data observably
    //    different (audit 2026-07-17) — pin it so a recost is reproducible.
    const { data: grnItems } = await sb.from('grn_items')
      .select('id, material_code, item_group, variants, unit_price_centi, qty_accepted, allocated_charge_centi, purchase_order_item_id')
      .eq('grn_id', grnId)
      .order('id', { ascending: true });
    if (!grnItems || grnItems.length === 0) return;
    const giList = grnItems as Array<{
      id: string; material_code: string; item_group: string | null;
      variants: Record<string, unknown> | null; unit_price_centi: number | null;
      qty_accepted: number | null; allocated_charge_centi: number | null;
      purchase_order_item_id: string | null;
    }>;

    /* Landed-cost core (migration 0082) — the GRN's exchange_rate (MYR per 1 unit
       of the GRN currency, 1 for MYR). Converts the GR-price FALLBACK
       (g.unit_price_centi, in the GRN's currency) to MYR. The PI path below uses
       the PI's OWN rate. rate 1 ⇒ toMyrSen is a no-op, so an MYR GRN recosts
       byte-for-byte as before. */
    /* `?? 1` is correct for an MYR GRN and a catastrophe for a failed read: rate 1
       means "this price is already MYR", so a blip on an RMB GRN capitalises the
       raw RMB figure into the lot as if it were ringgit — the whole cross-border
       landed cost wrong by the FX factor, silently, on a column that flows into
       every downstream DO/SI margin. A GRN that genuinely carries no rate
       resolves error === null with a null rate and MUST still fall through to 1. */
    const { data: grnHead, error: grnHeadErr } = await sb.from('grns').select('exchange_rate').eq('id', grnId).maybeSingle();
    if (grnHeadErr) {
      /* eslint-disable-next-line no-console */
      console.error('[recostFromGrn] GRN rate read failed — lot costs left unchanged:', grnId, grnHeadErr.message);
      return;
    }
    const grnRate = (grnHead as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;

    // 2. PI lines billing those GRN lines — the AUTHORITATIVE price (overrides
    //    GR). Weighted-average across all live (non-cancelled) PI lines per
    //    grn_item, so a partial / corrected invoice resolves cleanly.
    const giIds = giList.map((g) => g.id);
    /* A failed read folds to "no PI bills these lines", which is not neutral: the
       PI price is the AUTHORITATIVE cost and the GR price is only its fallback, so
       every lot below silently reverts to the un-invoiced GR estimate and the real
       billed cost is thrown away. A GRN that genuinely has no PI yet resolves
       error === null with data === [] and correctly keeps the GR fallback. */
    const { data: piRows, error: piRowsErr } = await sb.from('purchase_invoice_items')
      .select('grn_item_id, qty, unit_price_centi, purchase_invoice_id, allocated_charge_centi')
      .in('grn_item_id', giIds);
    if (piRowsErr) {
      /* eslint-disable-next-line no-console */
      console.error('[recostFromGrn] PI lines read failed — lot costs left unchanged:', grnId, piRowsErr.message);
      return;
    }
    const piList = (piRows ?? []) as Array<{ grn_item_id: string | null; qty: number; unit_price_centi: number | null; purchase_invoice_id: string; allocated_charge_centi: number | null }>;
    const piIds = [...new Set(piList.map((r) => r.purchase_invoice_id).filter(Boolean))];
    /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — exclude
       both CANCELLED AND DRAFT PIs from the authoritative-cost aggregate. A DRAFT PI
       commits no money and is not yet a real bill, so its line price must NEVER
       become the GRN lot's cost (which would silently flow into DO/SI margins). Only
       a confirmed POSTED/PARTIALLY_PAID/PAID PI is authoritative. */
    const piExcluded = new Set<string>();
    /* Landed-cost core (migration 0082) — each PI's OWN exchange_rate. A PI line
       price is in the PI's currency; the AUTHORITATIVE MYR lot cost is that price
       × the PI's rate. Different PIs billing the same GRN can carry different
       rates, so key the rate per purchase_invoice_id. */
    const piRateById = new Map<string, string | number | null>();
    if (piIds.length > 0) {
      /* This single read carries BOTH the leak guard above and the FX map, and a
         `?? []` fold breaks both at once and in the same direction — towards a
         confident wrong cost. Empty piExcluded means no PI is CANCELLED or DRAFT,
         so a draft PI's uncommitted price becomes the lot's authoritative cost —
         exactly what the LEAK GUARD note says must NEVER happen. Empty piRateById
         means every foreign PI line falls to `?? 1` and is booked as if its RMB
         price were ringgit. The rows we need are the ones we failed to read, so
         there is no safe way to proceed; nothing is written yet, so return. */
      const { data: pis, error: pisErr } = await sb.from('purchase_invoices').select('id, status, exchange_rate').in('id', piIds);
      if (pisErr) {
        /* eslint-disable-next-line no-console */
        console.error('[recostFromGrn] PI status/rate read failed — lot costs left unchanged:', grnId, pisErr.message);
        return;
      }
      for (const p of (pis ?? []) as Array<{ id: string; status: string; exchange_rate?: string | number | null }>) {
        const st = (p.status ?? '').toUpperCase();
        if (st === 'CANCELLED' || st === 'DRAFT') piExcluded.add(p.id);
        piRateById.set(p.id, p.exchange_rate ?? 1);
      }
    }
    // Aggregate the PI lines per grn_item as a weighted-average MYR cost: convert
    // EACH line's foreign price to MYR at its own PI's rate BEFORE averaging.
    const piAgg = new Map<string, { qty: number; amt: number }>();
    for (const r of piList) {
      if (!r.grn_item_id || piExcluded.has(r.purchase_invoice_id)) continue;
      const a = piAgg.get(r.grn_item_id) ?? { qty: 0, amt: 0 };
      const q = Number(r.qty ?? 0);
      const unitMyr = toMyrSen(Number(r.unit_price_centi ?? 0), piRateById.get(r.purchase_invoice_id) ?? 1);
      a.qty += q;
      a.amt += q * unitMyr;
      piAgg.set(r.grn_item_id, a);
    }

    /* PI-level landed freight (migration 0082) — freight entered on the PI as a
       SERVICE line, pooled + allocated across the PI's GOODS lines and stored per
       line as purchase_invoice_items.allocated_charge_centi (already MYR sen via
       the PI's own rate, computed at PI write time by reallocatePiCharges).
       SEPARATE from the GRN freight: the user enters freight on the GRN OR the PI
       (or both, deliberately), and each capitalises EXACTLY ONCE — the PI writer
       pools only PI-NATIVE service lines, never one copied down from the GRN.
       DRAFT/CANCELLED PIs excluded. 0 when a PI carries no service line. */
    const piFreightByGrnItem = new Map<string, number>();
    for (const r of piList) {
      if (!r.grn_item_id || piExcluded.has(r.purchase_invoice_id)) continue;
      const alloc = Number(r.allocated_charge_centi ?? 0);
      if (alloc === 0) continue;
      piFreightByGrnItem.set(r.grn_item_id, (piFreightByGrnItem.get(r.grn_item_id) ?? 0) + alloc);
    }

    /* 3. Authoritative landed cost PER LINE, then aggregated per LOT IDENTITY.
       WHY PER LINE (audit 2026-07-17): lots are one-per-GRN-line (the post writes
       one IN per line; the FIFO trigger opens one lot per IN). Keying cost by
       (material_code, variant_key) alone put every same-SKU line in ONE bucket and
       let the first-read line's price win for ALL of that SKU's lots — so a GRN
       spanning two POs (/from-po-items groups by SUPPLIER, lines keep their own
       purchase_order_item_id) booked the second PO's lot at the first PO's price.

       LOT IDENTITY: nothing links a lot back to its grn_item — inventory_movements
       carries no grn_item_id, only source_doc_id = the GRN. The finest identity the
       schema actually holds is (product_code, variant_key, batch_no), batch_no being
       the source PO number (migration 0120). That separates the multi-PO case
       exactly. Lines still tied on all three are genuinely indistinguishable — FIFO
       itself consumes them in arbitrary order — so they resolve to a qty-weighted
       average, which conserves Σ(qty × cost) EXACTLY (each line's qty IS its lot's
       qty_received). Order-independent, so the resolution no longer depends on the
       row order the DB happened to return.

       COARSE FALLBACK: a lot whose batch_no doesn't match any line's PO (pre-0120
       lots were stamped NULL) falls back to the (code, variant_key) aggregate —
       i.e. exactly the bucket this code used before — so refining the key can never
       leave a lot unmatched that previously resolved. */
    const batchByGrnItem = await poNumberByGrnItem(sb, giList);
    type Agg = { qty: number; amt: number };
    const byLotKey = new Map<string, Agg>();   // code::variant::batch — the lot's identity
    const byCoarse = new Map<string, Agg>();   // code::variant — pre-0120 fallback
    /* `amt` is a TOTAL, so callers may hand it one directly instead of a
       per-unit figure multiplied back up. That distinction is the whole of the
       freight fix below: rounding a charge to sen-per-unit and then multiplying
       by qty does not conserve the charge. */
    const addTo = (m: Map<string, Agg>, key: string, qty: number, landed: number) => {
      const a = m.get(key) ?? { qty: 0, amt: 0 };
      a.qty += qty;
      a.amt += qty * landed;
      m.set(key, a);
    };
    const addTotal = (m: Map<string, Agg>, key: string, qty: number, amt: number) => {
      const a = m.get(key) ?? { qty: 0, amt: 0 };
      a.qty += qty;
      a.amt += amt;
      m.set(key, a);
    };
    for (const g of giList) {
      const vkey = computeVariantKey(g.item_group, g.variants);
      const qty = Math.max(0, Number(g.qty_accepted ?? 0));
      const pi = piAgg.get(g.id);
      /* PI price (already MYR via piAgg) > GR price × GRN rate (→ MYR) > Pending.
         BOTH branches guard on a POSITIVE price. A zero is not a price in this
         schema — it is the absence of one: the FIFO trigger's COALESCE(unit_cost,0)
         means a never-priced lot already sits at 0, and Stage A reads 0 as
         "Pending". So a supplier billing RM0 (an FOC warranty replacement — the
         goods still cost real money when they were received) must fall through to
         the GR price, NOT overwrite a good lot with 0 and hand every sale of that
         stock a 100% margin. A PI that blends free units WITH billed ones still
         averages down through piAgg — that is a real landed cost, and it survives
         this guard because the average is > 0. */
      const piGoods = pi && pi.qty > 0 ? Math.round(pi.amt / pi.qty) : 0;
      const goods = piGoods > 0
        ? piGoods
        : (Number(g.unit_price_centi ?? 0) > 0 ? toMyrSen(Number(g.unit_price_centi), grnRate) : null);
      if (goods === null) continue; // Pending — no price anywhere yet; leave the lot alone.
      /* GRN-allocated freight + PI-allocated freight, each folded in per unit over
         the RECEIVED qty (the lot's qty) so the lot carries the whole charge once. */
      /* THE CHARGE IS ADDED AS A TOTAL, not as a rounded per-unit figure.
         It used to be `Math.round(charge / qty)` per source, and the aggregate
         then multiplied that back by qty — so 50 sen spread over 100 units
         became round(0.5) = 1 sen/unit = 100 sen capitalised against a 50-sen
         allocation. Twice the charge, from rounding alone, once per source.

         allocateLandedCharges guarantees Σ allocatedChargeCenti === the charge
         pool EXACTLY (lib/landed-allocation.ts:116-137, running remainder plus a
         lastPositiveIdx guard). Rounding it per unit threw that exactness away
         at the last step. Adding the charge whole and letting the aggregate
         divide ONCE preserves it; the goods half still enters per-unit, which is
         what it is. */
      const freightTotal = Number(g.allocated_charge_centi ?? 0) + (piFreightByGrnItem.get(g.id) ?? 0);
      const amt = qty * goods + freightTotal;
      addTotal(byLotKey, `${g.material_code}::${vkey}::${batchByGrnItem.get(g.id) ?? ''}`, qty, amt);
      addTotal(byCoarse, `${g.material_code}::${vkey}`, qty, amt);
    }
    const resolve = (a: Agg | undefined): number | null =>
      a && a.qty > 0 ? Math.round(a.amt / a.qty) : null;

    // 4. Lots created by this GRN. Re-cost each, then cascade to its consumptions.
    const { data: lots } = await sb.from('inventory_lots')
      .select('id, product_code, variant_key, batch_no, qty_received, movement_id, unit_cost_sen')
      .eq('source_doc_type', 'GRN').eq('source_doc_id', grnId);
    if (!lots || lots.length === 0) return;

    // Gather candidate consumptions per lot first (with the new cost), so we can
    // resolve which OUT movements belong to CANCELLED DOs and skip them BEFORE
    // re-stamping. A cancelled DO already reversed its stock at the cost booked
    // at cancel time; recosting it here would double-correct the GL.
    type ConsCand = { id: string; qty_consumed: number | null; movement_id: string | null; newCost: number };
    const consCandidates: ConsCand[] = [];
    for (const lot of lots as Array<{ id: string; product_code: string; variant_key: string | null; batch_no: string | null; qty_received: number | null; movement_id: string | null; unit_cost_sen: number | null }>) {
      const vkey = lot.variant_key ?? '';
      // The lot's own batch first; the pre-0120 (NULL-batch) fallback second.
      const newCost = resolve(
        byLotKey.get(`${lot.product_code}::${vkey}::${lot.batch_no ?? ''}`)
          ?? byCoarse.get(`${lot.product_code}::${vkey}`),
      );
      if (newCost === null) continue; // Pending — leave as-is
      if (Number(lot.unit_cost_sen ?? 0) === newCost) continue; // already correct

      // 4a. The lot's carrying cost.
      await sb.from('inventory_lots').update({ unit_cost_sen: newCost }).eq('id', lot.id);
      // 4b. The GRN IN movement that created the lot.
      if (lot.movement_id) {
        await sb.from('inventory_movements').update({
          unit_cost_sen: newCost,
          total_cost_sen: Number(lot.qty_received ?? 0) * newCost,
        }).eq('id', lot.movement_id);
      }
      // 4c. Collect every consumption drawing from this lot (real COGS rows).
      const { data: cons } = await sb.from('inventory_lot_consumptions')
        .select('id, qty_consumed, movement_id').eq('lot_id', lot.id);
      for (const ct of (cons ?? []) as Array<{ id: string; qty_consumed: number | null; movement_id: string | null }>) {
        consCandidates.push({ id: ct.id, qty_consumed: ct.qty_consumed, movement_id: ct.movement_id, newCost });
      }
    }

    // Resolve, for every candidate OUT movement, whether its source DO is
    // CANCELLED. A cancelled DO's OUT movements + consumptions + DO lines were
    // already settled at cancel time — exclude them from the recost cascade.
    const candidateMovIds = [...new Set(consCandidates.map((c) => c.movement_id).filter((x): x is string => !!x))];
    const movToDo = new Map<string, string>(); // movement_id → DO id (only DO-sourced)
    const cancelledMovIds = new Set<string>();
    if (candidateMovIds.length > 0) {
      const { data: movs } = await sb.from('inventory_movements')
        .select('id, source_doc_type, source_doc_id').in('id', candidateMovIds);
      const doIdSet = new Set<string>();
      for (const m of (movs ?? []) as Array<{ id: string; source_doc_type: string | null; source_doc_id: string | null }>) {
        if ((m.source_doc_type ?? '').toUpperCase() === 'DO' && m.source_doc_id) {
          movToDo.set(m.id, m.source_doc_id);
          doIdSet.add(m.source_doc_id);
        }
      }
      if (doIdSet.size > 0) {
        const { data: dos, error: dosErr } = await sb.from('delivery_orders').select('id, status').in('id', [...doIdSet]);
        /* `?? []` folds a failed read into "no DO here is cancelled" and 4c below
           then re-stamps consumptions the cancel already settled — the
           double-correction the note above forbids. Unlike the other sites in this
           file, aborting is NOT free: the lots and their IN movements were already
           re-costed ~40 lines up. It is still the safer half, and not by a small
           margin. The re-stamps are SETs, not deltas, so an abort leaves a
           half-recost that the NEXT PI touch recomputes from scratch and
           converges. Proceeding does the opposite: it overwrites a settled
           consumption's cost basis so the cancel's reversal no longer nets against
           the original, and because a later HEALTHY run correctly SKIPS cancelled
           DOs, nothing will ever revisit that row — the GL is wrong permanently.
           Self-healing beats unrecoverable. */
        if (dosErr) {
          /* eslint-disable-next-line no-console */
          console.error('[recostFromGrn] DO status read failed — consumptions NOT re-stamped (lots already re-costed; next PI touch reconverges):', grnId, dosErr.message);
          return;
        }
        const cancelledDoIds = new Set<string>();
        for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
          if ((d.status ?? '').toUpperCase() === 'CANCELLED') cancelledDoIds.add(d.id);
        }
        for (const [movId, doId] of movToDo) if (cancelledDoIds.has(doId)) cancelledMovIds.add(movId);
      }
    }

    // 4c (apply). Re-stamp each consumption EXCEPT those on a cancelled DO's OUT.
    const affectedOutMovements = new Set<string>();
    for (const ct of consCandidates) {
      if (ct.movement_id && cancelledMovIds.has(ct.movement_id)) continue; // cancelled DO — leave settled
      await sb.from('inventory_lot_consumptions').update({
        unit_cost_sen: ct.newCost,
        total_cost_sen: Number(ct.qty_consumed ?? 0) * ct.newCost,
      }).eq('id', ct.id);
      if (ct.movement_id) affectedOutMovements.add(ct.movement_id);
    }

    // 5. Recompute each affected OUT movement's total/unit cost from the (now
    //    re-costed) sum of its consumptions, and collect the DOs they belong to.
    //    Cancelled-DO movements were never added to affectedOutMovements above.
    const affectedDoIds = new Set<string>();
    for (const movId of affectedOutMovements) {
      const { data: mc, error: mcErr } = await sb.from('inventory_lot_consumptions')
        .select('qty_consumed, total_cost_sen').eq('movement_id', movId);
      /* The zeroing shape, on COGS: `?? []` folds a failed read to totalCost = 0
         and the update below stamps total_cost_sen = 0 / unit_cost_sen = 0 onto an
         OUT movement whose consumptions are intact. Every movId here came from a
         consumption we just re-stamped, so an empty result is not a real state —
         but skip per-movement rather than abort the loop: the movements are
         independent, and leaving this one at its previous cost keeps it merely
         stale (the next recost re-derives it) instead of confidently zero. */
      if (mcErr) {
        /* eslint-disable-next-line no-console */
        console.error('[recostFromGrn] consumption read failed — OUT movement cost left unchanged:', movId, mcErr.message);
        continue;
      }
      const rows = (mc ?? []) as Array<{ qty_consumed: number | null; total_cost_sen: number | null }>;
      const totalCost = rows.reduce((s, r) => s + Number(r.total_cost_sen ?? 0), 0);
      const totalQty = rows.reduce((s, r) => s + Number(r.qty_consumed ?? 0), 0);
      await sb.from('inventory_movements').update({
        total_cost_sen: totalCost,
        unit_cost_sen: totalQty > 0 ? Math.round(totalCost / totalQty) : 0,
      }).eq('id', movId);
      const { data: mv } = await sb.from('inventory_movements')
        .select('source_doc_type, source_doc_id').eq('id', movId).maybeSingle();
      const m = mv as { source_doc_type: string | null; source_doc_id: string | null } | null;
      if (m && (m.source_doc_type ?? '').toUpperCase() === 'DO' && m.source_doc_id) {
        affectedDoIds.add(m.source_doc_id);
      }
    }

    // 6. Re-stamp every affected DO line, then re-copy onto its Sales Invoices.
    for (const doId of affectedDoIds) {
      await restampDoActualCost(sb, doId);
      await restampSiFromDo(sb, doId);
    }
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[recostFromGrn] failed:', grnId, e); }
}

/* ── recostForPi — convenience wrapper ─────────────────────────────────────
   Resolve every GRN a Purchase Invoice touches (its header grn_id + each line's
   grn_item_id → grn_id) and recost each. Call after any PI create / line edit /
   line delete / cancel so a price change (or correction) propagates. */
export async function recostForPi(sb: any, piId: string) {
  try {
    const grnIds = new Set<string>();
    const { data: head } = await sb.from('purchase_invoices').select('grn_id').eq('id', piId).maybeSingle();
    const hGrn = (head as { grn_id: string | null } | null)?.grn_id ?? null;
    if (hGrn) grnIds.add(hGrn);

    const { data: lines } = await sb.from('purchase_invoice_items')
      .select('grn_item_id').eq('purchase_invoice_id', piId);
    const giIds = [...new Set(((lines ?? []) as Array<{ grn_item_id: string | null }>)
      .map((l) => l.grn_item_id).filter((x): x is string => !!x))];
    if (giIds.length > 0) {
      const { data: gi } = await sb.from('grn_items').select('grn_id').in('id', giIds);
      for (const g of (gi ?? []) as Array<{ grn_id: string | null }>) if (g.grn_id) grnIds.add(g.grn_id);
    }

    for (const gid of grnIds) await recostFromGrn(sb, gid);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[recostForPi] failed:', piId, e); }
}
