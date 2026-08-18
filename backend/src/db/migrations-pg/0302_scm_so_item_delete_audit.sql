-- 0302 — Record every DELETE of an SO line, so the next time a delivery loses
-- its `so_item_id` we can name the path that did it.
--
-- WHY. On 2026-08-17 twenty-six live delivery lines were found with
-- `so_item_id` NULL under a DO whose header still named the Sales Order. That
-- column is the only key MRP's delivered-netting and the CONFIRMED -> DELIVERED
-- flip read, so those shipments were invisible to both: the orders stayed
-- CONFIRMED and MRP asked Procurement to buy goods already at the customer's
-- house. #2355 repaired the rows and gave both engines a second reading; #2225
-- had already closed the write-side hole.
--
-- WHAT IS STILL UNEXPLAINED, and why this migration exists. Neither closed
-- cause fits the evidence:
--   · the FK is ON DELETE SET NULL, so deleting an SO line blanks the pointer —
--     but the SO lines are all still THERE, carrying their original created_at
--     (2990-SO-2607-012's seven lines still read 2026-07-12 11:03:50.664, the
--     second the order was created). Nothing was deleted and re-inserted.
--   · #2225's diagnosis was a client that omitted the field on write — but
--     2990-DO-2608-008 was raised through POST /from-sos, which sets
--     `so_item_id` explicitly, and its SO flipped to DELIVERED six seconds
--     later, a transition unreachable without the links being present.
-- So a third mechanism blanked them, and it is still live. The read-side
-- fallback means it will no longer show up as MRP re-ordering — it will be
-- silent, which is worse to find. This table is how we catch it in the act.
--
-- IT IS ALSO A FALSIFICATION TEST, not just a log. If the orphan sentinel
-- (.github/workflows/do-link-sentinel.yml) fires and this table has NO matching
-- row, that PROVES the FK path is not the mechanism and retires the theory. A
-- null result here is a real answer.
--
-- WHAT IT CAPTURES. The row that was deleted, plus every identity Postgres can
-- see from inside the trigger: the database role, the client's
-- application_name, the pid and the transaction id, and — the one that names a
-- HUMAN — the PostgREST JWT claims, which supabase-js sets as the
-- `request.jwt.claims` GUC on every request. current_setting(..., true)
-- returns NULL rather than raising when the GUC is absent (a psql session, a
-- migration, pg_cron), so a delete from any path is recorded, not just an API
-- one.
--
-- COST. One INSERT per deleted SO line. SO-line deletes are a human-scale
-- event (single-line removals and build swaps), not a bulk path, so this is
-- not on any hot loop.
--
-- Reversal: DROP TRIGGER trg_mfg_so_item_delete_audit ON scm.mfg_sales_order_items;
--           DROP FUNCTION scm.fn_mfg_so_item_delete_audit();
--           DROP TABLE scm.mfg_so_item_deletions;
--           Purely additive — nothing reads this table, so dropping it changes
--           no behaviour anywhere.

SET search_path TO scm, public;

CREATE TABLE IF NOT EXISTS scm.mfg_so_item_deletions (
  id               bigserial PRIMARY KEY,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  so_item_id       uuid        NOT NULL,
  doc_no           text,
  item_code        text,
  qty              numeric,
  company_id       bigint,
  -- Identity, widest-first. jwt_claims is the only one that names a person.
  jwt_claims       jsonb,
  db_user          text,
  application_name text,
  backend_pid      integer,
  txid             bigint
);

COMMENT ON TABLE scm.mfg_so_item_deletions IS
  'Forensic log of SO-line deletes (mig 0302). Exists to identify what blanks '
  'delivery_order_items.so_item_id via the ON DELETE SET NULL FK. Nothing reads '
  'it in application code; it is evidence, not state.';

CREATE INDEX IF NOT EXISTS mfg_so_item_deletions_deleted_at_idx
  ON scm.mfg_so_item_deletions (deleted_at DESC);
CREATE INDEX IF NOT EXISTS mfg_so_item_deletions_so_item_id_idx
  ON scm.mfg_so_item_deletions (so_item_id);

CREATE OR REPLACE FUNCTION scm.fn_mfg_so_item_delete_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
BEGIN
  INSERT INTO scm.mfg_so_item_deletions (
    so_item_id, doc_no, item_code, qty, company_id,
    jwt_claims, db_user, application_name, backend_pid, txid
  ) VALUES (
    OLD.id, OLD.doc_no, OLD.item_code, OLD.qty, OLD.company_id,
    /* PostgREST sets this GUC per request; absent (and therefore NULL) for a
       psql session, a migration or pg_cron. `true` = missing_ok, so this never
       raises and can never block the delete it is only observing. */
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    current_user,
    current_setting('application_name', true),
    pg_backend_pid(),
    txid_current()
  );
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  /* AN AUDIT MUST NEVER BREAK THE OPERATION IT WATCHES. A malformed JWT claim
     or a full disk would otherwise turn "remove a line" into a 500 for the
     operator. Swallow, and let the sentinel's own alarm be the thing that
     notices this table has gone quiet. */
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_mfg_so_item_delete_audit ON scm.mfg_sales_order_items;
CREATE TRIGGER trg_mfg_so_item_delete_audit
  AFTER DELETE ON scm.mfg_sales_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_mfg_so_item_delete_audit();
