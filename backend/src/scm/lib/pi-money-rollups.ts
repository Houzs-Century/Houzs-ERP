// ----------------------------------------------------------------------------
// pi-money-rollups — the purchase invoice's two DERIVED money writes.
//
// Extracted from routes/purchase-invoices.ts VERBATIM (2026-08-17) to buy that
// router file-size headroom for the unlinked-line and over-invoice guards. The
// two functions here were chosen because they are the largest blocks in it whose
// behaviour is entirely mechanical — sum the lines, split the pool — and because
// nothing asserts they live in the router: no test in backend/src, backend/tests-pg
// or frontend/src mentions either name.
//
// WHAT WAS NOT MOVED, and why it matters more than what was. The guards stay in
// the router: `findUnlinkedPiLines`'s call sites, `verifyGrnLinesNotOverInvoiced`,
// `recomputeGrnInvoiced`, `piLocked`, `migratedRefusalForGrnItems`. The
// unlinked-line suite proves the guards per HANDLER by slicing the router's own
// source, so moving a call site out would take a money guard's proof with it —
// which is buying file-size headroom with the only thing standing between one
// receipt and two payments.
//
// Both functions keep their contracts exactly: each FAILS CLOSED on a read error
// (leaving the stored figures untouched rather than writing a number derived from
// a read that did not happen) and neither throws.
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';
import { allocateLandedCharges, normalizeAllocationMethod } from '../lib/landed-allocation';

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around */
/* ── Recompute PI header money rollups (mirror recomputeGrnTotals) ─────────
   Sum line_total_centi across purchase_invoice_items → write subtotal_centi,
   then total_centi = subtotal + tax_centi (PI carries a stored tax that GRN
   does NOT, so we ADD it into total here). paid_centi is untouched — Balance
   (total - paid) is derived in the UI; payment recording stays on /payment.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
export async function recomputePiTotals(sb: any, piId: string) {
  const [itemsRes, headerRes] = await Promise.all([
    sb.from('purchase_invoice_items').select('line_total_centi').eq('purchase_invoice_id', piId),
    sb.from('purchase_invoices').select('tax_centi').eq('id', piId).maybeSingle(),
  ]);
  /* Neither read's error was looked at, and `?? []` / `?? 0` cannot tell a failed
     read from a real empty/zero: a blip on the ITEMS read wrote total_centi ZERO
     on an invoice the supplier is owed for, and a blip on the HEADER read wrote a
     total silently SHORT by the tax. Both are what this AP figure is paid from.
     The ERROR is the signal, never the emptiness: a genuinely line-less PI, and a
     PI that genuinely carries no tax, both resolve error === null and MUST still
     fall through. Neither of these two is more urgent than the other, so both
     abort before any write rather than half-writing from the half we trust. */
  if (itemsRes.error) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] item read failed — header left unchanged:', piId, itemsRes.error.message);
    return;
  }
  if (headerRes.error) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] tax read failed — header left unchanged:', piId, headerRes.error.message);
    return;
  }
  const subtotal = (itemsRes.data ?? []).reduce((s: number, r: any) => s + (r.line_total_centi ?? 0), 0);
  const tax = (headerRes.data as { tax_centi?: number } | null)?.tax_centi ?? 0;
  const { error: updErr } = await sb.from('purchase_invoices').update({
    subtotal_centi: subtotal,
    total_centi: subtotal + tax,
    updated_at: new Date().toISOString(),
  }).eq('id', piId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] header update failed — totals left STALE:', piId, updErr.message);
  }
}

/* ── PI-level landed freight ("平摊") — reallocatePiCharges ──────────────────
   Migration 0082 added purchase_invoice_items.allocated_charge_centi and recost.ts
   folds it into the FIFO lot cost — but until now NO write path ever filled it, so
   the column sat at 0 forever and freight billed on the SUPPLIER'S INVOICE (the
   normal shape for RMB / cross-border sourcing, where freight arrives on the PI
   rather than the GRN) raised the PI total and the AP but never reached inventory:
   COGS understated permanently. PurchaseInvoiceNew already ships the picker, sends
   allocationMethod, and its preview names this function as the authoritative
   splitter — this is that function.

   POOL = PI-NATIVE service lines only (grn_item_id IS NULL). A service line COPIED
   DOWN from the GRN by /from-grn keeps its grn_item_id, and that charge was ALREADY
   capitalised into the lot at receive time (grn_items.allocated_charge_centi, which
   recost re-adds separately) — pooling it again here would capitalise the same
   freight twice. This is what "each capitalises EXACTLY ONCE" means in recost.ts.

   Allocated across ALL goods lines, mirroring the GRN allocator. A goods line with
   no grn_item_id owns no lot, so its share simply doesn't capitalise — the goods
   aren't in inventory to carry it.

   Pure-on-empty: no native service line ⇒ pool 0 ⇒ allocation 0 everywhere ⇒ the
   column stays 0 and every existing PI recosts byte-for-byte as before.

   METHOD IS NOT PERSISTED: scm.purchase_invoices has no allocation_method column
   (0082 added one to grns only). The create paths pass the operator's choice; a
   later line edit has nothing to read it back from and re-splits by QTY. The pool
   still sums exactly either way — only the basis degrades. Persisting it needs a
   migration + a column. */
export async function reallocatePiCharges(
  sb: any,
  piId: string,
  method: ReturnType<typeof normalizeAllocationMethod> = 'QTY',
  /* The KEY is required and the absent VALUE is still expressible. `companyId?:`
     let a caller say nothing, and saying nothing here is spelled the same as
     "every company" — the volume read below keys on `code`, which is SHARED, so
     the other company's cubic metres would shift every goods line's share of the
     landed charge. Invisible while this function lived in routes/; the
     decision-param gate only scans src/scm/lib and src/scm/shared, so moving it
     here is what surfaced it. Every one of the seven call sites already passes
     `activeCompanyId(c)`, so runtime is unchanged. */
  companyId: number | null | undefined,
): Promise<void> {
  try {
    const [headRes, itemsRes] = await Promise.all([
      sb.from('purchase_invoices').select('exchange_rate').eq('id', piId).maybeSingle(),
      sb.from('purchase_invoice_items')
        .select('id, grn_item_id, material_code, item_group, qty, unit_price_centi, line_total_centi, allocated_charge_centi')
        .eq('purchase_invoice_id', piId),
    ]);
    /* `?? 1` means "already MYR", so a failed read on an RMB/USD PI allocates the
       freight pool at rate 1 and writes an allocated_charge_centi wrong by the
       whole FX factor onto every goods line — which recost then capitalises into
       the lot. The itemsRes read below fails closed (items = [] returns), but this
       one silently invents an exchange rate. Returning matches this function's own
       contract, stated in the catch: the PI's lines are already committed, a
       hiccup logs + skips and the split re-converges on the next line write. A PI
       that genuinely carries no rate resolves error === null and correctly uses 1. */
    if (headRes.error) {
      /* eslint-disable-next-line no-console */
      console.error('[reallocatePiCharges] PI rate read failed — charge split left unchanged:', piId, headRes.error.message);
      return;
    }
    const piRate = (headRes.data as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
    const items = (itemsRes.data ?? []) as Array<{
      id: string; grn_item_id: string | null; material_code: string; item_group: string | null;
      qty: number | null; unit_price_centi: number | null; line_total_centi: number | null;
      allocated_charge_centi: number | null;
    }>;
    if (items.length === 0) return;

    /* Drop GRN-copied service lines BEFORE the allocator sees them: it classifies
       by item_group/code alone and would otherwise pool a charge the GRN already
       capitalised. They are not goods either, so removing them leaves the goods
       basis untouched. */
    const visible = items.filter((it) =>
      !(it.grn_item_id && isServiceLine({ itemGroup: it.item_group, itemCode: it.material_code })));

    // CBM basis needs each goods line's product volume; one round trip, default 0
    // (the allocator falls back to QTY when the CBM Σ is 0).
    const m3ByCode = new Map<string, number>();
    const codes = [...new Set(visible.map((it) => it.material_code).filter(Boolean))];
    if (codes.length > 0) {
      // Company-scoped: `code` is shared, and the other company's volume would
      // shift every goods line's share of the landed charge.
      let volQ = sb.from('mfg_products').select('code, unit_m3_milli').in('code', codes);
      if (companyId != null) volQ = volQ.eq('company_id', companyId);
      /* BIND THE ERROR. Unbound, a failed volume read blanked every m3 and the
         allocator silently fell back to the QTY basis — a different split of the
         same freight pool, written into allocated_charge_centi and capitalised by
         recost into the FIFO lot. The fallback stays (this function is
         best-effort by contract) but it stops being silent. */
      const { data: prods, error: volErr } = await volQ;
      if (volErr) {
        /* eslint-disable-next-line no-console */
        console.error('[reallocatePiCharges] product volume read failed — CBM basis degrades to QTY:', piId, volErr.message);
      }
      for (const p of (prods ?? []) as Array<{ code: string; unit_m3_milli: number | null }>) {
        m3ByCode.set(p.code, Number(p.unit_m3_milli ?? 0));
      }
    }

    const alloc = allocateLandedCharges(
      visible.map((it) => ({
        id: it.id,
        itemGroup: it.item_group ?? null,
        materialCode: it.material_code,
        qty: Number(it.qty ?? 0),
        // Pool by the SERVICE line's line total; allocate ONTO the goods lines.
        amountCenti: Number(it.line_total_centi ?? 0),
        unitPriceCenti: Number(it.unit_price_centi ?? 0),
        unitM3Milli: m3ByCode.get(it.material_code) ?? 0,
      })),
      method,
      piRate,
    );

    /* Write the computed value (incl. resetting to 0) so a removed / re-split
       charge is reflected — but only when there's something to reconcile, so a
       plain goods-only PI issues no writes at all. Lines the allocator didn't
       return (the service lines themselves) are forced to 0: recost re-adds the
       charge of ANY line carrying a grn_item_id, so a row that used to be goods and
       was later retyped as freight would otherwise keep injecting a stale charge. */
    const anyToReset = items.some((it) => Number(it.allocated_charge_centi ?? 0) !== 0);
    if (alloc.chargePoolMyr > 0 || anyToReset) {
      const allocById = new Map(alloc.goods.map((g) => [g.id, g.allocatedChargeCenti]));
      await Promise.all(items.map((it) => {
        const next = allocById.get(it.id) ?? 0;
        if (Number(it.allocated_charge_centi ?? 0) === next) return null;
        return sb.from('purchase_invoice_items').update({ allocated_charge_centi: next }).eq('id', it.id);
      }).filter(Boolean));
    }
  } catch (e) {
    // Best-effort (audit-DLQ pattern): the PI's own lines already committed; a
    // freight-split hiccup logs + skips and re-converges on the next line write.
    // eslint-disable-next-line no-console
    console.error('[reallocatePiCharges] failed:', piId, e);
  }
}
