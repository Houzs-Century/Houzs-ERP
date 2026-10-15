-- RE-CHECK NUMBER AT MERGE — parallel PRs.
--
-- HC-0095 (15 Oct 2026): an approved SO amendment set a priced line to RM 0.
-- The editor used to send the 0 an unpriced SKU seeds into the price box as
-- new_unit_price_sen, and applySoAmendment believed any 0 once approved. The
-- frontend stopped sending a seeded 0 on 13 Oct (#4591), but rows already
-- queued, and old cached bundles, still carry one.
--
-- zero_price_intended = the operator TYPED 0 (the same claim the line PATCH
-- reads as zeroPriceIntended). The apply now honours a requested 0 only when
-- this is true; an unclaimed 0 keeps the line's stored price. Existing rows get
-- false, so a pending pre-fix 0 no longer zeroes a line on approval.
--
-- REVERSAL: ALTER TABLE scm.so_amendment_lines DROP COLUMN zero_price_intended;

ALTER TABLE scm.so_amendment_lines
  ADD COLUMN IF NOT EXISTS zero_price_intended boolean NOT NULL DEFAULT false;
