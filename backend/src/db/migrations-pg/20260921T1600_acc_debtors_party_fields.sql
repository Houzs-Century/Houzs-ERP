-- 20260921T1600_acc_debtors_party_fields.sql
-- REVERSAL: ALTER TABLE scm.acc_debtors DROP COLUMN IF EXISTS tin_number, DROP COLUMN IF EXISTS business_reg_no,
--   DROP COLUMN IF EXISTS contact_person, DROP COLUMN IF EXISTS attention, DROP COLUMN IF EXISTS email,
--   DROP COLUMN IF EXISTS phone2, DROP COLUMN IF EXISTS mobile, DROP COLUMN IF EXISTS whatsapp_number,
--   DROP COLUMN IF EXISTS fax, DROP COLUMN IF EXISTS address1, DROP COLUMN IF EXISTS address2,
--   DROP COLUMN IF EXISTS address3, DROP COLUMN IF EXISTS address4, DROP COLUMN IF EXISTS city,
--   DROP COLUMN IF EXISTS postcode, DROP COLUMN IF EXISTS state, DROP COLUMN IF EXISTS country; — every
--   column is new and nullable, nothing existing is altered or backfilled; a debtor keeps its name,
--   phone and notes. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- SEVENTEEN NULLABLE TEXT COLUMNS on scm.acc_debtors. No row changes, no index.
-- The deployed application keeps working whether or not this has run: the
-- routes that write them ship in the same PR, and every existing debtor
-- reads NULL — "not filled in", which is what every debtor is today.
--
-- WHY IT EXISTS (owner 2026-09-21: other debtor 做，他要填的资料就和 supplier
-- 的一样). The Other Debtor registry held a name, a phone and a note, so the
-- INVOICE every debtor bill prints (2026-09-18) could carry no address in its
-- BILL TO. The registry now takes the party's data as the supplier master
-- carries it — TIN and business registration numbers, contact person and
-- attention, the phones, email and fax, four address lines, city, postcode,
-- state and country — the same column names as scm.suppliers, so the two
-- masters read alike and an e-invoice can one day name the buyer from here.

SET search_path = public, scm;

ALTER TABLE scm.acc_debtors
  ADD COLUMN IF NOT EXISTS tin_number text,
  ADD COLUMN IF NOT EXISTS business_reg_no text,
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS attention text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone2 text,
  ADD COLUMN IF NOT EXISTS mobile text,
  ADD COLUMN IF NOT EXISTS whatsapp_number text,
  ADD COLUMN IF NOT EXISTS fax text,
  ADD COLUMN IF NOT EXISTS address1 text,
  ADD COLUMN IF NOT EXISTS address2 text,
  ADD COLUMN IF NOT EXISTS address3 text,
  ADD COLUMN IF NOT EXISTS address4 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS postcode text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS country text;
