
import { isServiceLine } from '../shared';
import { allocateLandedCharges, normalizeAllocationMethod } from '../lib/landed-allocation';
import { pgrestIn } from './pgrest-in-list';

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around */
export async function recomputePiTotals(sb: any, piId: string) {
  const [itemsRes, headerRes] = await Promise.all([
    sb.from('purchase_invoice_items').select('line_total_sen').eq('purchase_invoice_id', piId),
    sb.from('purchase_invoices').select('tax_sen').eq('id', piId).maybeSingle(),
  ]);
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
  const subtotal = (itemsRes.data ?? []).reduce((s: number, r: any) => s + (r.line_total_sen ?? 0), 0);
  const tax = (headerRes.data as { tax_sen?: number } | null)?.tax_sen ?? 0;
  const { error: updErr } = await sb.from('purchase_invoices').update({
    subtotal_sen: subtotal,
    total_sen: subtotal + tax,
    updated_at: new Date().toISOString(),
  }).eq('id', piId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pi-recompute] header update failed — totals left STALE:', piId, updErr.message);
  }
}

/* ── PI-level landed freight ("平摊") — reallocatePiCharges ──────────────────
   Migration 0082 added purchase_invoice_items.allocated_charge_sen and recost.ts
   folds it into the FIFO lot cost — but until now NO write path ever filled it, so
   the column sat at 0 forever and freight billed on the SUPPLIER'S INVOICE (the
   normal shape for RMB / cross-border sourcing, where freight arrives on the PI
   rather than the GRN) raised the PI total and the AP but never reached inventory:
   COGS understated permanently. PurchaseInvoiceNew already ships the picker, sends
   allocationMethod, and its preview names this function as the authoritative
   splitter — this is that function.

   POOL = PI-NATIVE service lines only (grn_item_id IS NULL). A service line COPIED
   DOWN from the GRN by /from-grn keeps its grn_item_id, and that charge was ALREADY
   capitalised into the lot at receive time (grn_items.allocated_charge_sen, which
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
  companyId: number | null | undefined,
): Promise<void> {
  try {
    const [headRes, itemsRes] = await Promise.all([
      sb.from('purchase_invoices').select('exchange_rate').eq('id', piId).maybeSingle(),
      sb.from('purchase_invoice_items')
        .select('id, grn_item_id, item_code, item_group, qty, unit_price_sen, line_total_sen, allocated_charge_sen')
        .eq('purchase_invoice_id', piId),
    ]);
    if (headRes.error) {
      /* eslint-disable-next-line no-console */
      console.error('[reallocatePiCharges] PI rate read failed — charge split left unchanged:', piId, headRes.error.message);
      return;
    }
    const piRate = (headRes.data as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
    const items = (itemsRes.data ?? []) as Array<{
      id: string; grn_item_id: string | null; item_code: string; item_group: string | null;
      qty: number | null; unit_price_sen: number | null; line_total_sen: number | null;
      allocated_charge_sen: number | null;
    }>;
    if (items.length === 0) return;

    const visible = items.filter((it) =>
      !(it.grn_item_id && isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })));

    const m3ByCode = new Map<string, number>();
    const codes = [...new Set(visible.map((it) => it.item_code).filter(Boolean))];
    if (codes.length > 0) {
      let volQ = pgrestIn(sb.from('mfg_products').select('code, unit_m3_milli'), 'code', codes);
      if (companyId != null) volQ = volQ.eq('company_id', companyId);
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
        itemCode: it.item_code,
        qty: Number(it.qty ?? 0),
        amountSen: Number(it.line_total_sen ?? 0),
        unitPriceSen: Number(it.unit_price_sen ?? 0),
        unitM3Milli: m3ByCode.get(it.item_code) ?? 0,
      })),
      method,
      piRate,
    );

    const anyToReset = items.some((it) => Number(it.allocated_charge_sen ?? 0) !== 0);
    if (alloc.chargePoolMyr > 0 || anyToReset) {
      const allocById = new Map(alloc.goods.map((g) => [g.id, g.allocatedChargeSen]));
      await Promise.all(items.map((it) => {
        const next = allocById.get(it.id) ?? 0;
        if (Number(it.allocated_charge_sen ?? 0) === next) return null;
        return sb.from('purchase_invoice_items').update({ allocated_charge_sen: next }).eq('id', it.id);
      }).filter(Boolean));
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[reallocatePiCharges] failed:', piId, e);
  }
}
