
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { isEntityType } from '../lib/entity-audit';
import { scopeToCompany } from '../lib/companyScope';
import { canViewScmFinance } from '../lib/houzs-perms';
import { stripAuditFinance } from '../lib/finance-keys';
import { labelAuditIds, type AuditLabelReader } from '../lib/audit-id-labels';

export const entityAuditLog = new Hono<{ Bindings: Env; Variables: Variables }>();
entityAuditLog.use('*', supabaseAuth);

const SELECT =
  'id, entity_type, entity_id, entity_doc_no, action, actor_id, actor_name_snapshot, ' +
  'field_changes, status_snapshot, source, note, created_at';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

entityAuditLog.get('/:entityType/:entityId', async (c) => {
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');

  if (!isEntityType(entityType)) {
    return c.json({ error: 'unknown_entity_type', message: `No audit trail is kept for "${entityType}".` }, 400);
  }
  if (!entityId) return c.json({ error: 'entity_id_required' }, 400);

  const rawLimit = Number(c.req.query('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const sb = c.get('supabase');
  let q = sb.from('entity_audit_log')
    .select(SELECT)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .limit(limit);
  q = scopeToCompany(q, c);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const entries = (data ?? []) as unknown as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  const labelsFailed = await labelAuditIds(sb as unknown as AuditLabelReader, entries);
  return c.json(labelsFailed.length ? { entries, labels_unavailable: labelsFailed } : { entries });
});

export default entityAuditLog;
