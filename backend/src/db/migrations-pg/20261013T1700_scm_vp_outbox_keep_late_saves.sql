-- ----------------------------------------------------------------------------
-- 20261013T1700 — the Venture Portal outbox keeps a save that lands while its
-- order is in flight.
--
-- WHY. drainVenturePortalOutbox builds an order's payload, POSTs it, and only
-- then marks the row sent. A save in between met the still-pending row, and
-- ON CONFLICT ... DO NOTHING folded it into a delivery that had already been
-- built; the row was marked sent and nothing queued the order again, so the
-- portal kept the order as it was a second earlier. Production, 2026-10-13,
-- compared with the portal's copy: 20 September / October orders behind this
-- system (a payment missing on 13, a total on 3, a brand on 3, a status on 1).
-- HC-SO-2609-271: its line was saved at RM 3,500 and the header total
-- recomputed 1.6 s later, after the payload was built, so the portal still
-- reads RM 1,750.
--
-- FIX. A trigger that finds the pending row bumps its `revision`; the drain
-- marks a row sent only while `revision` is still the one it read before
-- building the payload, and leaves it pending otherwise, so the next sweep
-- sends the newer state. The bodies below are production's (md5 checked
-- 2026-10-13) with the conflict action as the only change.
--
-- REVERSAL: deploy a drain that does not select `revision` first, then re-run
-- the three CREATE OR REPLACE FUNCTION statements below with
-- `ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING` in place of the
-- DO UPDATE clause, then ALTER TABLE scm.venture_portal_outbox DROP COLUMN
-- revision. No grant is lost: CREATE OR REPLACE keeps a function's ACL.
-- RE-RUN: no-op (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE).
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

ALTER TABLE scm.venture_portal_outbox
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN scm.venture_portal_outbox.revision IS
  'Bumped by every save that finds this row still pending. The drain marks the row sent only while revision equals what it read before building the payload, so a save made while the delivery is in flight is sent again, never folded into it.';

CREATE OR REPLACE FUNCTION scm.enqueue_vp_outbox() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
BEGIN
  BEGIN
    INSERT INTO scm.venture_portal_outbox (doc_no, op)
    VALUES (COALESCE(NEW.doc_no, OLD.doc_no), TG_OP)
    ON CONFLICT (doc_no) WHERE status = 'pending'
    DO UPDATE SET revision = scm.venture_portal_outbox.revision + 1,
                  updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION scm.enqueue_vp_outbox_child() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
DECLARE
  keycol text := TG_ARGV[0];
  dn     text;
BEGIN
  BEGIN
    dn := COALESCE(to_jsonb(NEW) ->> keycol, to_jsonb(OLD) ->> keycol);
    IF dn IS NOT NULL THEN
      INSERT INTO scm.venture_portal_outbox (doc_no, op)
      VALUES (dn, TG_OP || ':' || TG_TABLE_NAME)
      ON CONFLICT (doc_no) WHERE status = 'pending'
      DO UPDATE SET revision = scm.venture_portal_outbox.revision + 1,
                    updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION scm.enqueue_vp_outbox_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
BEGIN
  BEGIN
    INSERT INTO scm.venture_portal_outbox (doc_no, op)
    SELECT so.doc_no, 'UPDATE:projects'
      FROM scm.mfg_sales_orders so
     WHERE so.project_id = NEW.id
    ON CONFLICT (doc_no) WHERE status = 'pending'
    DO UPDATE SET revision = scm.venture_portal_outbox.revision + 1,
                  updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;
