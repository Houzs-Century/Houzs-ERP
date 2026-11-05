-- 20261029T1700_fix_fleet_sync_user_to_tms — Fleet drivers stop vanishing.
--
-- SYMPTOM. An outsourced / Penang driver entered against an employee account
-- never stayed in Fleet -> Drivers (that list shows active rows only), and a
-- driver's hand-typed phone got wiped on the next edit of the account.
--
-- CAUSE. scm.sync_user_to_tms() — the AFTER-trigger on public.users that mirrors
-- a driver / helper account into scm.drivers / scm.helpers — only counted a user
-- as a driver when the position was EXACTLY 'driver'. An "outsource transporter"
-- (a 3PL driver) fell into the ELSE branch, which sets active=false, so the
-- Fleet row was deactivated and disappeared. The row's name / phone / IC were
-- also overwritten from the account on every change (phone -> '' when the
-- account had none), blanking what the dispatcher filled.
--
-- FIX, drivers and helpers alike:
--   1. 'outsource transporter' is a driver too (in_house = false), so an
--      outsource / Penang driver keeps a Fleet row instead of being deactivated.
--   2. Never blank a dispatcher-entered contact / IC: the account's value is
--      taken only when it is non-empty; otherwise the Fleet / helper row keeps
--      its own.
--   3. A Fleet / helper row is retired only when the account is DISABLED
--      (soft-deleted), not merely because its position label changed.
--
-- This also brings the trigger INTO the repo for the first time: it was applied
-- by hand on production and lived in no migration (the same gap 0327 closed for
-- scm.drivers.user_id). CREATE OR REPLACE plus a guarded CREATE TRIGGER make it
-- idempotent and let a fresh rebuild match production. pg-migrate runs the file
-- in one transaction, so there is no window where the trigger is absent.
--
-- REVERSAL: restores the previous production behaviour (run by hand to undo).
--   CREATE OR REPLACE FUNCTION scm.sync_user_to_tms() RETURNS trigger LANGUAGE plpgsql AS $function$
--   DECLARE pos text; is_driver boolean; is_helper boolean; v_company bigint;
--   BEGIN
--     SELECT lower(p.name) INTO pos FROM public.positions p WHERE p.id = NEW.position_id;
--     is_driver := (NEW.status <> 'disabled' AND pos = 'driver');
--     is_helper := (NEW.status <> 'disabled' AND (pos IN ('helper','storekeeper','storekeeper supervisor') OR pos LIKE 'warehouse crew%'));
--     SELECT id INTO v_company FROM public.companies WHERE code = 'HOUZS'; v_company := coalesce(v_company, 1);
--     IF is_driver THEN
--       UPDATE scm.drivers SET name=NEW.name, phone=coalesce(NEW.phone,''), ic_number=NEW.ic_number, active=true WHERE user_id=NEW.id;
--       IF NOT FOUND THEN INSERT INTO scm.drivers (user_id, driver_code, name, phone, ic_number, in_house, active, company_id)
--         VALUES (NEW.id, 'DRV-'||lpad(nextval('scm.driver_code_seq')::text,3,'0'), NEW.name, coalesce(NEW.phone,''), NEW.ic_number, true, true, v_company); END IF;
--     ELSE UPDATE scm.drivers SET active=false WHERE user_id=NEW.id AND active; END IF;
--     IF is_helper THEN
--       UPDATE scm.helpers SET name=NEW.name, contact=NEW.phone, ic_number=NEW.ic_number, active=true WHERE user_id=NEW.id;
--       IF NOT FOUND THEN INSERT INTO scm.helpers (user_id, helper_code, name, contact, ic_number, in_house, active, company_id)
--         VALUES (NEW.id, 'HLP-'||lpad(nextval('scm.helper_code_seq')::text,3,'0'), NEW.name, NEW.phone, NEW.ic_number, true, true, v_company); END IF;
--     ELSE UPDATE scm.helpers SET active=false WHERE user_id=NEW.id AND active; END IF;
--     RETURN NEW;
--   END $function$;

SET search_path = scm, public;

CREATE OR REPLACE FUNCTION scm.sync_user_to_tms()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  pos text;
  is_driver boolean;
  is_helper boolean;
  v_company bigint;
BEGIN
  -- "Not disabled" (active OR invited) — field drivers / helpers are invited
  -- staff who never log into the ERP, so they stay status='invited' forever;
  -- only a soft-deleted user (status='disabled') is excluded.
  SELECT lower(p.name) INTO pos FROM public.positions p WHERE p.id = NEW.position_id;

  -- "outsource transporter" is a 3PL driver and belongs in the Fleet list too
  -- (in_house = false). It used to be excluded, so outsource / Penang drivers
  -- were deactivated and vanished from Fleet -> Drivers.
  is_driver := (NEW.status <> 'disabled' AND pos IN ('driver', 'outsource transporter'));
  is_helper := (NEW.status <> 'disabled' AND (pos IN ('helper', 'storekeeper', 'storekeeper supervisor') OR pos LIKE 'warehouse crew%'));

  SELECT id INTO v_company FROM public.companies WHERE code = 'HOUZS';
  v_company := coalesce(v_company, 1);

  -- DRIVER module
  IF is_driver THEN
    UPDATE scm.drivers
      SET name = NEW.name,
          -- Never blank a dispatcher-entered contact: take the account's value
          -- only when it actually has one; otherwise keep what Fleet holds.
          phone = CASE WHEN coalesce(NEW.phone, '') <> '' THEN NEW.phone ELSE phone END,
          ic_number = coalesce(NEW.ic_number, ic_number),
          active = true
      WHERE user_id = NEW.id;
    IF NOT FOUND THEN
      INSERT INTO scm.drivers (user_id, driver_code, name, phone, ic_number, in_house, active, company_id)
      VALUES (NEW.id, 'DRV-' || lpad(nextval('scm.driver_code_seq')::text, 3, '0'),
              NEW.name, coalesce(NEW.phone, ''), NEW.ic_number, (pos = 'driver'), true, v_company);
    END IF;
  ELSIF NEW.status = 'disabled' THEN
    -- Only a disabled (soft-deleted) account retires its Fleet row; a mere
    -- position change must not silently deactivate a hand-managed driver.
    UPDATE scm.drivers SET active = false WHERE user_id = NEW.id AND active;
  END IF;

  -- HELPER module (Helper + Storekeeper + Storekeeper Supervisor + Warehouse Crew *)
  IF is_helper THEN
    UPDATE scm.helpers
      SET name = NEW.name,
          contact = CASE WHEN coalesce(NEW.phone, '') <> '' THEN NEW.phone ELSE contact END,
          ic_number = coalesce(NEW.ic_number, ic_number),
          active = true
      WHERE user_id = NEW.id;
    IF NOT FOUND THEN
      INSERT INTO scm.helpers (user_id, helper_code, name, contact, ic_number, in_house, active, company_id)
      VALUES (NEW.id, 'HLP-' || lpad(nextval('scm.helper_code_seq')::text, 3, '0'),
              NEW.name, NEW.phone, NEW.ic_number, true, true, v_company);
    END IF;
  ELSIF NEW.status = 'disabled' THEN
    UPDATE scm.helpers SET active = false WHERE user_id = NEW.id AND active;
  END IF;

  RETURN NEW;
END $function$;

-- Capture the trigger wiring into the repo (idempotent): it already exists on
-- production and is left untouched there; a fresh rebuild now creates it to match.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_user_to_tms' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_sync_user_to_tms
      AFTER INSERT OR UPDATE OF position_id, status, name, phone, ic_number
      ON public.users
      FOR EACH ROW EXECUTE FUNCTION scm.sync_user_to_tms();
  END IF;
END $$;
