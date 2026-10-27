-- 20261027T1000_scm_delivery_board_changes.sql
--
-- WHY. Delivery Planning shows ~700 working orders that people change every few
-- seconds (dates, status, crew, payments, stock flips, DOs). The board only
-- re-read on an edit or a page load, so a coordinator looked at stale rows and
-- WhatsApp messages went out with old dates (owner 2026-10-26/27, option B).
-- The board now asks every 30 s "which orders changed since my last look" and
-- re-reads only those (?docs=, #4962).
--
-- WHY A LOG AND NOT updated_at. The order lines carry no updated_at, and a stock
-- flip or a DO / crew / trip / payment change does not touch the order header -
-- a "changed since" read on header timestamps misses them (Hookka ERP hit
-- exactly this, plus string-compared timestamps; see the PR). A trigger on every
-- table the board reads records the order a write touched, whoever wrote it, and
-- the client pages the log by its own serial id, so no clock is ever compared.
--
-- SAFETY. The trigger swallows its own errors: logging a change must never fail
-- the business write it follows. Rows older than 2 days are pruned
-- probabilistically by the trigger itself. doc_no '*OTHER*' marks a change to a
-- service case, DP job or project leg (the board re-reads those wholesale).
--
-- REVERSAL:
--   DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.mfg_sales_orders;
--   ... the same for each table listed under TRIGGERS below ...
--   DROP FUNCTION IF EXISTS scm.fn_delivery_board_change();
--   DROP TABLE IF EXISTS scm.delivery_board_changes;
--   Purely additive: dropping it only stops the board's 30-second refresh.

SET search_path TO scm, public;

CREATE TABLE IF NOT EXISTS scm.delivery_board_changes (
  id          bigserial   PRIMARY KEY,
  doc_no      text        NOT NULL,
  company_id  bigint,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_board_changes_changed_at_idx ON scm.delivery_board_changes (changed_at);

ALTER TABLE scm.delivery_board_changes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON TABLE scm.delivery_board_changes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE scm.delivery_board_changes_id_seq TO service_role;

COMMENT ON TABLE scm.delivery_board_changes IS
  'Which Sales Order a write touched, for Delivery Planning''s 30-second refresh '
  '(GET /delivery-planning/changes). Written only by scm.fn_delivery_board_change; '
  'pruned after 2 days.';

CREATE OR REPLACE FUNCTION scm.fn_delivery_board_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  r     jsonb;
  v_doc text;
  v_co  bigint;
  v_do  uuid;
BEGIN
  r := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  IF TG_TABLE_NAME IN ('mfg_sales_orders', 'mfg_sales_order_items') THEN
    v_doc := r->>'doc_no';
    v_co  := (r->>'company_id')::bigint;
  ELSIF TG_TABLE_NAME IN ('mfg_sales_order_payments', 'delivery_orders') THEN
    v_doc := r->>'so_doc_no';
    v_co  := (r->>'company_id')::bigint;
  ELSIF TG_TABLE_NAME IN ('delivery_order_items', 'delivery_order_crew', 'trip_stops') THEN
    v_do := COALESCE(r->>'delivery_order_id', r->>'do_id')::uuid;
    IF v_do IS NOT NULL THEN
      SELECT d.so_doc_no, d.company_id INTO v_doc, v_co FROM scm.delivery_orders d WHERE d.id = v_do;
    ELSIF TG_TABLE_NAME = 'trip_stops' THEN
      v_doc := '*OTHER*';
    END IF;
  ELSIF TG_TABLE_NAME = 'trips' THEN
    INSERT INTO scm.delivery_board_changes (doc_no, company_id)
      SELECT DISTINCT d.so_doc_no, d.company_id
        FROM scm.trip_stops ts JOIN scm.delivery_orders d ON d.id = ts.do_id
       WHERE ts.trip_id = (r->>'id')::uuid AND d.so_doc_no IS NOT NULL;
    v_doc := '*OTHER*';
  ELSE
    -- dp_orders, assr_cases, projects: a non-SO leg changed.
    v_doc := '*OTHER*';
    v_co  := (r->>'company_id')::bigint;
  END IF;
  IF v_doc IS NOT NULL THEN
    INSERT INTO scm.delivery_board_changes (doc_no, company_id) VALUES (v_doc, v_co);
  END IF;
  IF random() < 0.001 THEN
    DELETE FROM scm.delivery_board_changes WHERE changed_at < now() - interval '2 days';
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Never fail the business write because the change log could not be written.
  RETURN NULL;
END;
$$;

-- TRIGGERS: every table the board reads for an order or a leg.
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.mfg_sales_orders;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.mfg_sales_orders
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.mfg_sales_order_items;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.mfg_sales_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.mfg_sales_order_payments;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.mfg_sales_order_payments
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.delivery_orders;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.delivery_order_items;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.delivery_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.delivery_order_crew;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.delivery_order_crew
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.trip_stops;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.trip_stops
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.trips;
CREATE TRIGGER trg_delivery_board_change AFTER UPDATE OR DELETE ON scm.trips
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON scm.dp_orders;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON scm.dp_orders
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON public.assr_cases;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON public.assr_cases
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
DROP TRIGGER IF EXISTS trg_delivery_board_change ON public.projects;
CREATE TRIGGER trg_delivery_board_change AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION scm.fn_delivery_board_change();
