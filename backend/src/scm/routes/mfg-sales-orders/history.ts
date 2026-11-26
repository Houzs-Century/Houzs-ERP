import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { canViewScmFinance } from '../../lib/houzs-perms';
import { stripAuditFinance } from '../../lib/finance-keys';
import { labelAuditIds, type AuditLabelReader } from '../../lib/audit-id-labels';

export function registerHistoryRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
mfgSalesOrders.get('/:docNo/audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('mfg_so_audit_log')
    .select('id, so_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note, created_at')
    .eq('so_doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const entries = (data ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  const labelsFailed = await labelAuditIds(sb as unknown as AuditLabelReader, entries);
  return c.json(labelsFailed.length ? { entries, labels_unavailable: labelsFailed } : { entries });
});

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
  const labelsFailed = await labelAuditIds(sb as unknown as AuditLabelReader, entries);
  return c.json(labelsFailed.length ? { entries, labels_unavailable: labelsFailed } : { entries });
});

mfgSalesOrders.get('/:docNo/status-changes', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('mfg_so_status_changes')
    .select('id, doc_no, from_status, to_status, changed_by, notes, auto_actions, created_at')
    .eq('doc_no', docNo), c)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ statusChanges: data ?? [] });
});

mfgSalesOrders.get('/:docNo/revisions', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await scopeToCompany(sb.from('so_revisions')
    .select('id, revision, snapshot, created_at, created_by')
    .eq('so_doc_no', docNo), c)
    .order('revision', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ revisions: data ?? [] });
});

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
