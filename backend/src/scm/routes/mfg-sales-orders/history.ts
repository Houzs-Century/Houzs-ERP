import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { canViewScmFinance } from '../../lib/houzs-perms';
import { stripAuditFinance } from '../../lib/finance-keys';

/* GET /:docNo/audit-log, /related-audit-log, /status-changes, /revisions, /price-overrides — moved out of mfg-sales-orders.ts, which calls this where the block
   stood, so registration order is unchanged. The body is moved verbatim and left
   unindented on purpose: source tests anchor on `\nmfgSalesOrders.<verb>(`. */
export function registerHistoryRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
// ── GET /mfg-sales-orders/:docNo/audit-log ──────────────────────────
// PR-D — unified history feed (newest first). Returns one envelope:
//   { entries: [{ id, so_doc_no, action, actor_id, actor_name_snapshot,
//                  field_changes, status_snapshot, source, note, created_at }] }
mfgSalesOrders.get('/:docNo/audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  /* so_doc_no is the ONLY key here and doc numbers are unique per company by
     PREFIX, not by constraint — so a 2990 number pasted into the Houzs URL used
     to return 2990's history. Same predicate the /:docNo/revisions read below
     already carries; mfg_so_audit_log took company_id in mig 0083. */
  const { data, error } = await scopeToCompany(sb.from('mfg_so_audit_log')
    .select('id, so_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note, created_at')
    .eq('so_doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* The audit HISTORY is a finance read too — this route's own line PATCH does
     `cmp('unitCostSen', prev.unit_cost_sen, unitCost)`, so field_changes
     carries the old AND new unit cost. gateSoFinance strips the DETAIL, so
     leaving this open just moves the leak one endpoint over. Shared vocabulary
     (lib/finance-keys) — the consignment audit-log reads this SAME table. */
  const entries = (data ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  return c.json({ entries });
});

// ── GET /mfg-sales-orders/:docNo/related-audit-log ──────────────────
// The History drawer showed only the SO's own log, so the PO raised for it, the
// DO that shipped it and the invoice that billed it were invisible there (ticket
// DEV-16: "why history did not show the PO created date & time"). Those rows
// live in entity_audit_log keyed by the child document's id, so this resolves
// the SO's children through the same hard links the relationship map uses
// (so_item_id on PO / allocation / DO lines, so_doc_no on DO / SI headers) and
// returns their rows in the audit-log envelope, tagged with entity_type and
// entity_doc_no. The "From SOs:" note link is not scanned: it needs a read of
// every noted PO in the company, and it only matters for pre-so_item_id POs.
//
// Lifecycle moves only. A PO's line edits and supplier-date changes would bury
// the SO's own timeline; they stay in the child's own History, one click away
// through the doc-number link the drawer renders. AMENDMENT_PO_APPROVED is the
// PO being re-derived from this SO's own amendment, so it answers the SO's
// "amendment so approved" row.
const RELATED_AUDIT_ACTIONS = ['CREATE', 'POST', 'SEND', 'CANCEL', 'REVERSE', 'DELETE', 'AMENDMENT_PO_APPROVED'];
mfgSalesOrders.get('/:docNo/related-audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const fail = (reason: string) => c.json({ error: 'load_failed', reason }, 500);

  const { data: soItems, error: soItemErr } = await scopeToCompany(sb.from('mfg_sales_order_items')
    .select('id').eq('doc_no', docNo), c);
  if (soItemErr) return fail(soItemErr.message);
  const soItemIds = ((soItems ?? []) as Array<{ id: string }>).map((r) => r.id);

  const poIds = new Set<string>();
  const doIds = new Set<string>();
  const siIds = new Set<string>();

  if (soItemIds.length) {
    const [poLines, doLines] = await Promise.all([
      scopeToCompany(sb.from('purchase_order_items').select('purchase_order_id').in('so_item_id', soItemIds), c),
      scopeToCompany(sb.from('delivery_order_items').select('delivery_order_id').in('so_item_id', soItemIds), c),
    ]);
    if (poLines.error) return fail(poLines.error.message);
    if (doLines.error) return fail(doLines.error.message);
    for (const r of (poLines.data ?? []) as Array<{ purchase_order_id: string | null }>) if (r.purchase_order_id) poIds.add(r.purchase_order_id);
    for (const r of (doLines.data ?? []) as Array<{ delivery_order_id: string | null }>) if (r.delivery_order_id) doIds.add(r.delivery_order_id);

    /* A shared stock buy carries the SO on an allocation slice, not the PO line.
       The allocations table postdates some environments (mig 0235), so a failed
       read here only drops those POs instead of failing the drawer. */
    const { data: allocs, error: allocErr } = await sb.from('purchase_order_item_allocations')
      .select('purchase_order_item_id').in('so_item_id', soItemIds);
    const allocItemIds = allocErr ? [] : [...new Set(((allocs ?? []) as Array<{ purchase_order_item_id: string }>).map((a) => a.purchase_order_item_id))];
    if (allocItemIds.length) {
      const { data: allocLines, error: allocLineErr } = await scopeToCompany(sb.from('purchase_order_items')
        .select('purchase_order_id').in('id', allocItemIds), c);
      if (allocLineErr) return fail(allocLineErr.message);
      for (const r of (allocLines ?? []) as Array<{ purchase_order_id: string | null }>) if (r.purchase_order_id) poIds.add(r.purchase_order_id);
    }
  }

  const [doHeads, siHeads] = await Promise.all([
    scopeToCompany(sb.from('delivery_orders').select('id').eq('so_doc_no', docNo), c),
    scopeToCompany(sb.from('sales_invoices').select('id').eq('so_doc_no', docNo), c),
  ]);
  if (doHeads.error) return fail(doHeads.error.message);
  if (siHeads.error) return fail(siHeads.error.message);
  for (const r of (doHeads.data ?? []) as Array<{ id: string }>) doIds.add(r.id);
  for (const r of (siHeads.data ?? []) as Array<{ id: string }>) siIds.add(r.id);

  const ids = [...poIds, ...doIds, ...siIds];
  if (!ids.length) return c.json({ entries: [] });

  const { data, error } = await scopeToCompany(sb.from('entity_audit_log')
    .select('id, entity_type, entity_id, entity_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note, created_at')
    .in('entity_type', ['PURCHASE_ORDER', 'DELIVERY_ORDER', 'SALES_INVOICE'])
    .in('entity_id', ids)
    .in('action', RELATED_AUDIT_ACTIONS), c)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return fail(error.message);
  const entries = (data ?? []) as unknown as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  return c.json({ entries });
});

// GET — list status change history for the SO detail timeline.
mfgSalesOrders.get('/:docNo/status-changes', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('mfg_so_status_changes')
    .select('id, doc_no, from_status, to_status, changed_by, notes, auto_actions, created_at')
    .eq('doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ statusChanges: data ?? [] });
});

// GET — list SO revision snapshots for the Detail "Revisions" tab (Phase 6b).
// Each row is a full header+lines snapshot captured when an amendment's approve-so
// gate re-derived the SO (so_revisions, keyed on so_doc_no + revision). Newest
// first so the tab lists the latest revision on top. Mirrors the audit-log read
// above: supabase select, plain load_failed on error. scopeToCompany: so_revisions
// carries company_id (mig 0080); no-op pre-activation.
mfgSalesOrders.get('/:docNo/revisions', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('so_revisions')
    .select('id, revision, snapshot, created_at, created_by')
    .eq('so_doc_no', docNo), c)
    .order('revision', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ revisions: data ?? [] });
});

// GET — list line price overrides for the audit panel.
mfgSalesOrders.get('/:docNo/price-overrides', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('mfg_so_price_overrides')
    .select('id, doc_no, item_id, item_code, original_price_sen, override_price_sen, reason, approved_by, created_at')
    .eq('doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ overrides: data ?? [] });
});
}
