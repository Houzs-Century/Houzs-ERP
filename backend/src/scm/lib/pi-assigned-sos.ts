// ----------------------------------------------------------------------------
// pi-assigned-sos — the list's "Assigned SO" / "Delivered" enrichment.
//
// Extracted from routes/purchase-invoices.ts VERBATIM (2026-08-17), same reason
// and same rule as pi-money-rollups. This one is READ-ONLY and fail-soft: on any
// error the rows still return, just without the columns populated. It writes
// nothing, decides nothing, and no test named it.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this tree passes around */
import { scopeToCompany } from '../lib/companyScope';
import {
  resolvePoSoCoveragePerSkuForPos, resolveDeliveredByCodeForPos, summarizeOrigins,
  type DeliveredDo,
} from '../routes/po-so-coverage';

/* Collapsed "Assigned SO" column (owner 2026-07-31): a PI inherits its parent
   PO's Assigned SO(s). Resolve the parent PO through the SAME chain the per-line
   drill-down uses (pi.grn_id → grns.purchase_order_id → PO), so the list row and
   its expansion never disagree, then batch the coverage for the whole page in
   ONE pass (computeMrp runs once). Fail-soft: on any error the rows still return,
   just without the column populated. */
export async function attachPiAssignedSos(
  sb: any,
  c: any,
  rows: Array<{ id: string; grn_id?: string | null } & Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  try {
    const grnIds = [...new Set(rows.map((r) => r.grn_id).filter((x): x is string => !!x))];
    const poByGrn = new Map<string, string>();
    for (let k = 0; k < grnIds.length; k += 300) {
      const chunk = grnIds.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const { data: grnRows } = await scopeToCompany(
        sb.from('grns').select('id, purchase_order_id'), c,
      ).in('id', chunk);
      for (const g of (grnRows ?? []) as Array<{ id: string; purchase_order_id: string | null }>) {
        if (g.purchase_order_id) poByGrn.set(g.id, g.purchase_order_id);
      }
    }
    const poIds = [...poByGrn.values()];
    /* Each PI's OWN line codes (header ≡ ∪(drill lines), 2026-08-02): the drill
       matches assignments into the PI's lines by material_code, so the header
       cells roll up ONLY those SKUs — a partial-billing PI must not inherit
       its parent PO's whole assignment history. */
    const piIds = rows.map((r) => r.id).filter(Boolean);
    const codesByPi = new Map<string, Set<string>>();
    for (let k = 0; k < piIds.length; k += 300) {
      const chunk = piIds.slice(k, k + 300);
      if (chunk.length === 0) continue;
      const { data: piLines } = await sb.from('purchase_invoice_items')
        .select('purchase_invoice_id, material_code')
        .in('purchase_invoice_id', chunk);
      for (const l of (piLines ?? []) as Array<{ purchase_invoice_id: string; material_code: string | null }>) {
        const code = (l.material_code ?? '').trim();
        if (!code) continue;
        const set = codesByPi.get(l.purchase_invoice_id) ?? new Set<string>();
        set.add(code);
        codesByPi.set(l.purchase_invoice_id, set);
      }
    }
    /* "Delivered" column (owner 2026-07-31): the DO(s) that shipped the goods,
       per CODE via the SAME pi → grn → PO chain, filtered to the PI's codes. */
    const [originsByPo, deliveredByPoCode] = await Promise.all([
      resolvePoSoCoveragePerSkuForPos(sb, c, poIds),
      resolveDeliveredByCodeForPos(sb, c, poIds),
    ]);
    return rows.map((r) => {
      const poId = r.grn_id ? poByGrn.get(r.grn_id) : undefined;
      const piCodes = codesByPi.get(r.id) ?? new Set<string>();
      const origins = (poId ? originsByPo.get(poId) ?? [] : [])
        .filter((o) => piCodes.has(o.itemCode));
      const summary = summarizeOrigins(origins);
      const doAgg = new Map<string, DeliveredDo>();
      if (poId) {
        const byCode = deliveredByPoCode.get(poId);
        if (byCode) {
          for (const code of piCodes) {
            for (const d of byCode.get(code) ?? []) {
              const prev = doAgg.get(d.doNo);
              if (prev) prev.qty += d.qty;
              else doAgg.set(d.doNo, { ...d });
            }
          }
        }
      }
      return {
        ...r,
        assigned_sos: summary.assignedSos,
        assigned_so_linked: summary.sourceLinked,
        /* PR-3 (2026-08-07, additive): the stored-origin "bought for" SO(s) —
           rolled up over the SAME code-filtered origins (header ≡ ∪(lines)). */
        assigned_so_provenance: summary.provenanceSos,
        delivered_dos: [...doAgg.values()].sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true })),
      };
    });
  } catch {
    return rows.map((r) => ({ ...r, assigned_sos: [], assigned_so_linked: false, assigned_so_provenance: [], delivered_dos: [] }));
  }
}
