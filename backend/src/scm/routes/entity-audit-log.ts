// ----------------------------------------------------------------------------
// /entity-audit-log — the read side of scm.entity_audit_log (migration 0139):
// the field-change history for every SCM document that is NOT a Sales Order.
//
// Mirrors GET /mfg-sales-orders/:docNo/audit-log deliberately, down to the
// `{ entries: [...] }` envelope and the newest-first ordering, so the shared
// History drawer can be pointed at either endpoint without a second adapter.
// The only shape difference is the key: (entityType, entityId) instead of a
// single doc number.
//
// ── WHY THE FINANCE STRIP RUNS HERE TOO ──
// stripAuditFinance exists because the SO history carried unit costs in
// field_changes while the SO detail stripped them — "stripping the detail while
// leaving the history just moves the leak one endpoint over" (lib/finance-keys).
// This log records payment vouchers and stock adjustments, so it is the same
// hazard with the same answer: one shared vocabulary, applied on every surface
// that reads a field_changes blob. Applying it here costs a non-finance reader
// nothing and means a cost key added to AUDIT_FINANCE_FIELDS is gated on both
// tables at once.
//
// READ-ONLY BY CONSTRUCTION. entity_audit_log is append-only by intent (see the
// migration header) and this router exposes no POST, PATCH or DELETE. Writes go
// through lib/entity-audit.recordEntityAudit from the handler that owns the
// business operation, never through an endpoint a client can call directly — an
// audit trail anyone can write arbitrary rows into records nothing.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { isEntityType } from '../lib/entity-audit';
import { scopeToCompany } from '../lib/companyScope';
import { canViewScmFinance } from '../lib/houzs-perms';
import { stripAuditFinance } from '../lib/finance-keys';

export const entityAuditLog = new Hono<{ Bindings: Env; Variables: Variables }>();
entityAuditLog.use('*', supabaseAuth);

const SELECT =
  'id, entity_type, entity_id, entity_doc_no, action, actor_id, actor_name_snapshot, ' +
  'field_changes, status_snapshot, source, note, created_at';

/* An unbounded history read is the mistake nobody notices until the book is
   large. A stock take with 500 lines can produce many UPDATE rows, so the read
   is capped well under PostgREST's silent 1000-row ceiling rather than paging:
   a History drawer shows recent activity, and a caller that needs everything
   should ask for it explicitly once something needs it. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * GET /entity-audit-log/:entityType/:entityId — one document's history, newest
 * first.
 *
 * Returns { entries: [{ id, entity_type, entity_id, entity_doc_no, action,
 *   actor_id, actor_name_snapshot, field_changes, status_snapshot, source,
 *   note, created_at }] }.
 */
entityAuditLog.get('/:entityType/:entityId', async (c) => {
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');

  /* Rejected rather than passed through to an empty result: an unknown type is
     a caller bug (a typo, a module that was never wired up), and answering it
     with `{ entries: [] }` reads as "this document has no history" — the single
     most misleading answer an audit endpoint can give. */
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
  /* The SCM client is service-role, so RLS is bypassed and this app-layer
     predicate is the only company boundary. Three-state (lib/companyScope):
     unresolved leaves single-company Houzs unchanged. Rows written before a
     company could be resolved carry company_id NULL by design (see the
     migration header) and are filtered out here rather than leaked across
     companies — the conservative direction for a cross-company read. */
  q = scopeToCompany(q, c);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* Cast through unknown: the scm client is SupabaseClient<any>, so a .select()
     built from a concatenated string infers as GenericStringError[] rather than
     the row shape (same reason payment-audit-log.ts casts its own read). */
  const entries = (data ?? []) as unknown as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  return c.json({ entries });
});

export default entityAuditLog;
