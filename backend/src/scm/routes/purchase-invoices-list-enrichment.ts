// ----------------------------------------------------------------------------
// purchase-invoices-list-enrichment — the DEFERRED half of the PI list.
//
// Opening the Purchase Invoices list used to run a full company-wide `computeMrp`
// on the critical path: the list called attachPiAssignedSos, which resolves the
// "Assigned SO" / "Delivered" columns through resolvePoSoCoveragePerSkuForPos,
// and THAT runs the global MRP engine once per load (~4s, the list's dominant
// cost — same disease the SO list had before #2433). The list now returns
// immediately WITHOUT those four columns, and the client calls this endpoint
// once, for the page it just rendered, to heal them a beat later:
//
//   GET /purchase-invoices/list-mrp-enrichment?piIds=UUID,UUID,UUID
//     -> { enrichment: { [piId]: { assigned_sos, assigned_so_linked,
//                                   assigned_so_provenance, delivered_dos } } }
//
// It re-reads each requested PI's (id, grn_id) under the SAME company scope the
// list applies (the tenant boundary — a spoofed id from another company yields
// nothing), then runs the SAME attachPiAssignedSos the list used to run inline,
// so the healed values are byte-identical to the old path, only deferred.
//
// Its own thin router, mounted at the same `/purchase-invoices` prefix (Hono
// resolves this static path ahead of the main router's `/:id`). Auth + the
// scm.procurement.pi area guard cover it via the shared `/purchase-invoices/*`
// middleware in scm/index.ts, exactly as they cover the list.
//
// Fail-soft, exactly like the list: attachPiAssignedSos already swallows its own
// errors to empty columns, so a failed MRP drops to empty Assigned-SO / Delivered
// cells and never 500s the page.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this SCM tree passes around (see companyScope.ts header). */
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { attachPiAssignedSos, pickPiListMrpEnrichment } from '../lib/pi-assigned-sos';
import { attachGrnLineFacts, piPoPriceSummaryByInvoice, type PiPoPriceSummary } from '../lib/pi-po-price';

export const purchaseInvoicesListEnrichment = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoicesListEnrichment.use('*', supabaseAuth);

/* One list page is capped at 100 rows (the list handler's pageSize cap), so a
   well-behaved client asks for at most that many. Bound it defensively — the
   endpoint is read-only, but computeMrp downstream is company-wide work and
   there is no reason to fan a giant unbounded list into it. */
const MAX_IDS = 200;

purchaseInvoicesListEnrichment.get('/list-mrp-enrichment', async (c) => {
  const sb = c.get('supabase') as any;

  const raw = (c.req.query('piIds') ?? '').trim();
  const piIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (piIds.length === 0) return c.json({ enrichment: {} });

  /* Re-read (id, grn_id) under the company predicate — the tenant boundary. The
     ids come from a page the client already received, so this is also defence
     in depth: an id from another company simply does not come back. */
  const { data, error } = await scopeToCompany(
    sb.from('purchase_invoices').select('id, grn_id'), c,
  ).in('id', piIds);
  if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<{ id: string; grn_id: string | null }>;
  if (rows.length === 0) return c.json({ enrichment: {} });

  const enriched = await attachPiAssignedSos(sb, c, rows);

  const enrichment: Record<string, Record<string, unknown>> = {};
  for (const r of enriched) {
    const id = r.id as string;
    if (id) enrichment[id] = pickPiListMrpEnrichment(r);
  }
  return c.json({ enrichment });
});

/* ── PO price vs invoice price, per invoice (owner 2026-09-14) ─────────────
   GET /purchase-invoices/list-po-price?piIds=UUID,UUID
     -> { summary: { [piId]: { linesDiffering, totalDiffSen, comparableLines, lines } } }

   The marker the list shows so a person can see, without opening an invoice,
   that some lines were billed at a price other than the purchase order's. It
   reads the lines through the SAME attachGrnLineFacts the detail page uses —
   the stored trail where there is one, the live join for a line written before
   the trail existed — so the list and the detail cannot count differently.
   Information only: nothing is blocked, approved or reconciled off it. */
purchaseInvoicesListEnrichment.get('/list-po-price', async (c) => {
  const sb = c.get('supabase') as any;
  const raw = (c.req.query('piIds') ?? '').trim();
  const piIds = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (piIds.length === 0) return c.json({ summary: {} });

  // Same tenant boundary as the list: an id from another company does not come back.
  const { data: heads, error: hErr } = await scopeToCompany(sb.from('purchase_invoices').select('id'), c).in('id', piIds);
  if (hErr) return c.json({ error: 'enrichment_failed', reason: hErr.message }, 500);
  const ids = ((heads ?? []) as Array<{ id: string }>).map((h) => h.id);
  if (ids.length === 0) return c.json({ summary: {} });

  const { data: lines, error: lErr } = await sb.from('purchase_invoice_items')
    .select('id, purchase_invoice_id, grn_item_id, qty, unit_price_sen, po_unit_price_sen')
    .in('purchase_invoice_id', ids);
  if (lErr) return c.json({ error: 'enrichment_failed', reason: lErr.message }, 500);
  const items = (lines ?? []) as Array<Record<string, unknown> & { id: string; purchase_invoice_id: string; grn_item_id?: string | null }>;
  await attachGrnLineFacts(sb, items);

  const summary: Record<string, PiPoPriceSummary> = {};
  for (const [id, s] of piPoPriceSummaryByInvoice(items)) summary[id] = s;
  return c.json({ summary });
});
