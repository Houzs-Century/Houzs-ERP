-- 0139_scm_entity_audit_log.sql — the audit trail for every SCM document that is
-- NOT a Sales Order.
--
-- THE GAP THIS CLOSES. The owner's rule (2026-05-27, restated 2026-07-18) is that
-- every edit records WHO, WHEN to the minute, and WHAT changed from-value ->
-- to-value. Exactly ONE document type obeys it: the Sales Order, via
-- scm.mfg_so_audit_log and lib/so-audit.ts (47 call sites). A survey of the SCM
-- route tree found 71 of 78 route files writing no audit row at all — and the
-- uncovered set includes every path that moves MONEY OUT (payment vouchers, which
-- post a GL entry and settle purchase invoices) and every path that moves STOCK
-- TRUTH (GRN post/cancel, stock takes, stock transfers, manual adjustments).
-- A posted payment voucher could be cancelled and reversed out of the ledger with
-- no record of who did it.
--
-- WHY A NEW TABLE AND NOT mfg_so_audit_log. That table is keyed `so_doc_no text
-- NOT NULL` with an FK-shaped relationship to mfg_sales_orders.doc_no. A GRN or a
-- stock take has no SO to hang off, and inventing a synthetic so_doc_no to smuggle
-- one in would poison the SO History drawer, which reads that table by doc number.
-- The SO-specific key is replaced here by the generic pair (entity_type, entity_id).
--
-- WHY THE SHAPE IS COPIED RATHER THAN DESIGNED. mfg_so_audit_log's column set is
-- the PROVEN one — it has served the History drawer through 47 call sites and the
-- #625/#600 finance-strip work. action / actor_id / actor_name_snapshot /
-- field_changes / status_snapshot / source / note / created_at are carried over
-- verbatim so the read side, the finance strip (lib/finance-keys.stripAuditFinance)
-- and any future shared History component treat both tables identically.
--
-- ── mfg_so_audit_log HAS NO NUMBERED MIGRATION, AND THAT IS WHY THIS ONE EXISTS ──
-- The SO audit table was never created by a file in this directory. It arrives
-- through backend/scripts/scm-schema/2990s-full-schema.sql, the one-time 2990
-- schema import, which is NOT part of the deploy's migration tree. Migration 0083
-- knows this: its ALTER is wrapped in `IF EXISTS (SELECT 1 FROM pg_class ...)` and
-- silently does nothing when the table is absent. So the SO audit trail is only
-- present on databases that received the import, and a clean database built from
-- migrations alone would have `recordSoAudit` failing on every write — invisibly,
-- because that writer swallows its errors.
--
-- This table must therefore NOT repeat that. It is created here, by a real
-- numbered migration, so it exists on every environment the migration runner
-- touches (prod, staging, and any rebuild) rather than only where a script was
-- once run by hand.
--
-- ── APPEND-ONLY BY INTENT ──
-- Nothing in the application updates or deletes a row here: lib/entity-audit.ts
-- exposes a writer and the read route exposes a SELECT, and there is no third
-- path. A correction is a NEW row, never an edit of an old one — an audit trail
-- whose rows can be rewritten answers a different, useless question. This is
-- enforced by the absence of code, not by a grant: the SCM client is service-role
-- and would bypass a REVOKE anyway, so a permission here would be decoration that
-- reads like a guarantee.
--
-- ── COMPANY_ID IS NULLABLE, DELIBERATELY ──
-- 0083 made mfg_so_audit_log.company_id NOT NULL, which is safe there because the
-- SO always resolves one. Here the writer is best-effort and fail-open (a failed
-- audit insert must never fail the business operation it is recording), so a
-- NOT NULL column would convert "the company lookup hiccuped" into "the audit row
-- was silently dropped" — losing exactly the record this table exists to keep.
-- A row with an unknown company is worth more than no row.
--
-- HOUSE STYLE (0130/0133/0135/0137): additive, IF NOT EXISTS, plain statements,
-- SET search_path, no runtime self-apply.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.entity_audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id          bigint,
  -- The generic key that replaces mfg_so_audit_log.so_doc_no. entity_id is text
  -- rather than uuid because the documents covered here are keyed by uuid today
  -- but the vocabulary must survive a future entity keyed by a doc number.
  entity_type         text NOT NULL,
  entity_id           text NOT NULL,
  -- The HUMAN key (PV-2607-001, GRN-2607-014), carried alongside the uuid because
  -- entity_id alone renders as a uuid in a History drawer. Nullable: a create can
  -- record before its number is minted.
  entity_doc_no       text,
  action              text NOT NULL,
  actor_id            uuid,
  actor_name_snapshot text,
  field_changes       jsonb DEFAULT '[]'::jsonb NOT NULL,
  status_snapshot     text,
  source              text DEFAULT 'web',
  note                text,
  created_at          timestamp with time zone DEFAULT now() NOT NULL
);

-- The read pattern: one document's history, newest first. Matches the SO
-- audit-log read this mirrors.
CREATE INDEX IF NOT EXISTS idx_entity_audit_log_entity
  ON scm.entity_audit_log (entity_type, entity_id, created_at DESC);

-- The per-actor question ("what did this person touch"), which the SO log cannot
-- answer at all. Partial because an unattributed row is never the answer to it.
CREATE INDEX IF NOT EXISTS idx_entity_audit_log_actor
  ON scm.entity_audit_log (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_audit_log_company_id
  ON scm.entity_audit_log (company_id);
