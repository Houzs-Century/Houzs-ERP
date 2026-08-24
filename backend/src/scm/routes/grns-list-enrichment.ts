// ----------------------------------------------------------------------------
// grns-list-enrichment — the DEFERRED half of the Goods Received list.
//
// Opening the GRN list used to run a full company-wide `computeMrp` on the
// critical path: the list resolved its "Assigned SO" / "Delivered" columns
// through resolvePoSoCoveragePerSkuForPos, which runs the global MRP engine once
// per load (~4s, the list's dominant cost — the same disease #2433 cured on the
// SO list and PI/PO got cured of before this). The list now returns immediately
// WITHOUT those four columns, and the client calls THIS endpoint once, for the
// page it just rendered, to heal them a beat later:
//
//   GET /grns/list-mrp-enrichment?grnIds=UUID,UUID,UUID
//     -> { enrichment: { [grnId]: { assigned_sos, assigned_so_linked,
//                                    assigned_so_provenance, delivered_dos } } }
//
// It reproduces the list's EXACT assembly, so the healed values are byte-
// identical, only deferred: each GRN's parent PO (grns.purchase_order_id) feeds
// the per-SKU coverage engine, and the columns roll up over ONLY that GRN's own
// line codes (header == union(drill lines), 2026-08-02) — a partial-receipt GRN
// must not inherit its parent PO's assignments for SKUs it never received.
//
// Its own thin router, mounted at the same `/grns` prefix (Hono resolves this
// static path ahead of the main router's `/:id`). Auth + the scm.procurement.grn
// area guard cover it via the shared `/grns/*` middleware in scm/index.ts.
//
// Fail-soft, like the list: the resolvers swallow their own errors to empty
// summaries, so a failed MRP drops to empty cells and never 500s the page.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this SCM tree passes around (see companyScope.ts header). */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { resolvePoSoCoveragePerSkuForPos, resolveDeliveredByCodeForPos, summarizeOrigins, type DeliveredDo } from './po-so-coverage';
export { LIST_MRP_ENRICHMENT_KEYS } from '../lib/list-mrp-enrichment-keys';

export const grnsListEnrichment = new Hono<{ Bindings: Env; Variables: Variables }>();
grnsListEnrichment.use('*', supabaseAuth);

/* One list page is capped at 100 rows, so a well-behaved client asks for at most
   that many. Bound it defensively — computeMrp downstream is company-wide work. */
const MAX_IDS = 200;

grnsListEnrichment.get('/list-mrp-enrichment', async (c) => {
  const sb = c.get('supabase') as any;

  const raw = (c.req.query('grnIds') ?? '').trim();
  const grnIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (grnIds.length === 0) return c.json({ enrichment: {} });

  /* Re-read the GRN headers under the company predicate — the tenant boundary —
     to get each one's parent PO. A spoofed id from another company yields no row. */
  const { data: hdrs, error: hdrErr } = await scopeToCompany(
    sb.from('grns').select('id, purchase_order_id'), c,
  ).in('id', grnIds);
  if (hdrErr) return c.json({ error: 'enrichment_failed', reason: hdrErr.message }, 500);

  const rows = ((hdrs ?? []) as Array<{ id: string; purchase_order_id: string | null }>);
  if (rows.length === 0) return c.json({ enrichment: {} });
  const ids = rows.map((g) => g.id);
  const poByGrn = new Map<string, string | null>();
  for (const g of rows) poByGrn.set(g.id, g.purchase_order_id);

  /* Each GRN's OWN line codes — the columns roll up ONLY these SKUs, exactly as
     the list does. */
  const codesByGrn = new Map<string, Set<string>>();
  {
    const { data: lineRows, error: lineErr } = await paginateAll<{ grn_id: string; item_code: string | null }>((from, to) => sb
      .from('grn_items')
      .select('grn_id, item_code')
      .in('grn_id', ids)
      .order('id')
      .range(from, to));
    if (lineErr) return c.json({ error: 'enrichment_failed', reason: lineErr.message }, 500);
    for (const li of (lineRows ?? []) as Array<{ grn_id: string; item_code: string | null }>) {
      const code = (li.item_code ?? '').trim();
      if (!code) continue;
      const set = codesByGrn.get(li.grn_id) ?? new Set<string>();
      set.add(code);
      codesByGrn.set(li.grn_id, set);
    }
  }

  /* The SAME two resolvers the list ran inline, keyed on the parent POs. */
  const poIds = rows.map((g) => g.purchase_order_id);
  const [originsByPo, deliveredByPoCode] = await Promise.all([
    resolvePoSoCoveragePerSkuForPos(sb, c, poIds),
    resolveDeliveredByCodeForPos(sb, c, poIds),
  ]);

  const enrichment: Record<string, Record<string, unknown>> = {};
  for (const g of rows) {
    const poId = poByGrn.get(g.id) ?? null;
    const grnCodes = codesByGrn.get(g.id) ?? new Set<string>();
    const origins = (poId ? originsByPo.get(poId) ?? [] : []).filter((o) => grnCodes.has(o.itemCode));
    const summary = summarizeOrigins(origins);
    const doAgg = new Map<string, DeliveredDo>();
    if (poId) {
      const byCode = deliveredByPoCode.get(poId);
      if (byCode) {
        for (const code of grnCodes) {
          for (const d of byCode.get(code) ?? []) {
            const prev = doAgg.get(d.doNo);
            if (prev) prev.qty += d.qty;
            else doAgg.set(d.doNo, { ...d });
          }
        }
      }
    }
    enrichment[g.id] = {
      assigned_sos: summary.assignedSos,
      assigned_so_linked: summary.sourceLinked,
      assigned_so_provenance: summary.provenanceSos,
      delivered_dos: [...doAgg.values()].sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true })),
    };
  }
  return c.json({ enrichment });
});
