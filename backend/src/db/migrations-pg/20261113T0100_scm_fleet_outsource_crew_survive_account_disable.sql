-- 20261113T0100_scm_fleet_outsource_crew_survive_account_disable
--
-- SYMPTOM. Penang / outsource drivers and helpers (MSJ TRANSPORT crew,
-- in_house = false) kept vanishing from the Project "Setup & Dismantle — crew
-- per lorry" pickers AND from Delivery Planning's Driver / Helper dropdowns.
-- Both surfaces read the same active-only roster (/api/scm/drivers | /helpers),
-- so the name dropped from both at once, over and over.
--
-- CAUSE. scm.sync_user_to_tms() (the AFTER-trigger on public.users) mirrors a
-- crew account into scm.drivers / scm.helpers. When the account was DISABLED it
-- set the linked Fleet / helper row active = false. But an outsource transporter
-- is not our employee: their ERP account is an invite that gets disabled in
-- routine Member cleanups, while their 3PL driver record must stay on the
-- roster. 20261029T1700 fixed the position matching but still let a disabled
-- account retire an outsource row.
--
-- FIX. On account disable, deactivate ONLY an in-house row (in_house IS NOT
-- FALSE — true, or the historical NULL default). An outsource row
-- (in_house = false, i.e. a 3PL / Penang transporter) keeps its Fleet / helper
-- record and stays pickable no matter what happens to the employee account.
-- Nothing else in the trigger changes from 20261029T1700.
--
-- REVERSAL (run by hand to undo): restore 20261029T1700's body — drop the
--   `AND in_house IS NOT FALSE` clause from both disable branches below.

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
  -- "Not disabled" (active OR invited): field crew are invited staff who never
  -- log in, so they stay status='invited'; only a soft-deleted user is excluded.
  SELECT lower(p.name) INTO pos FROM public.positions p WHERE p.id = NEW.position_id;

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
    -- Only an IN-HOUSE driver follows the employee account into retirement. An
    -- outsource / 3PL driver (in_house = false) stays on the Fleet roster even
    -- when its invite account is disabled, so Penang transporters no longer
    -- vanish from the Setup/Dismantle and Delivery Planning crew pickers.
    UPDATE scm.drivers SET active = false
      WHERE user_id = NEW.id AND active AND in_house IS NOT FALSE;
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
    -- Same rule for helpers: an outsource helper (in_house = false) is kept.
    UPDATE scm.helpers SET active = false
      WHERE user_id = NEW.id AND active AND in_house IS NOT FALSE;
  END IF;

  RETURN NEW;
END $function$;

-- The trigger wiring already exists on production (captured idempotently in
-- 20261029T1700); recreate it only on a fresh rebuild that lacks it.
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
