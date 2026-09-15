import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { canViewScmFinance } from '../../lib/houzs-perms';
import { stripAuditFinance } from '../../lib/finance-keys';

/* GET /:docNo/audit-log, /status-changes, /revisions, /price-overrides — moved out of mfg-sales-orders.ts, which calls this where the block
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
