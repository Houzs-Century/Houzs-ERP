-- 0242 — a 3PL carrier gets a CODE, like every other master in this system.
--
-- WHY. Owner, 2026-08-02: "我们的 driver code、我们的 lorry code，还有包括 3PL 的
-- code，应该全部都是自动的". scm.threepl_companies (0210) was identified by NAME
-- alone — `UNIQUE (company_id, name)` and nothing else — so there was no short
-- stable handle to put on a document, quote in a message, or print on a report,
-- and a rename silently changed the only thing anyone could refer to.
--
-- NULLABLE + BACKFILLED, NOT NOT-NULL. A NOT NULL column on a populated table
-- needs a DEFAULT or a backfill inside the same statement, and a generated
-- DEFAULT cannot see the other rows. So: add nullable, backfill deterministically,
-- and let the route mint from there. The partial UNIQUE index means a row that
-- somehow never got one does not block every other row from having theirs.
--
-- THE BACKFILL IS ORDERED BY created_at, id — a stable order, so a re-run (or a
-- fresh environment restored from the same data) produces the SAME codes. An
-- ORDER BY over a non-unique key would hand the same company a different code
-- in staging than in production, which is worse than no code at all.
--
-- WHY NOT per-company numbering for drivers/helpers too. Their codes are
-- GLOBALLY unique by design — scm.drivers.driver_code carries a bare
-- UNIQUE(driver_code) and drivers.ts states the reason ("UNIFIED FLEET: the
-- driver roster is one shared list across ALL companies"). That is a different
-- decision from this table, which is company-scoped, and this migration does
-- not touch it.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0242 was next free above 0241.

SET search_path = scm, public;

ALTER TABLE scm.threepl_companies
  ADD COLUMN IF NOT EXISTS code TEXT NULL;

-- Backfill: 3PL-001.. per company, oldest first. Three-wide to match every
-- other minted code in the system (DRV-/HLP-/WS-) — see scm/lib/fleet-code-mint. Only rows that have none, so
-- re-running this file (or applying it to a partially-migrated tree) is a no-op.
WITH numbered AS (
  SELECT id,
         company_id,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id) AS n
  FROM scm.threepl_companies
  WHERE code IS NULL OR code = ''
)
UPDATE scm.threepl_companies t
SET code = '3PL-' || LPAD(numbered.n::text, 3, '0')
FROM numbered
WHERE t.id = numbered.id;

-- Unique WHEN PRESENT. Partial so a future row that arrives without a code (a
-- direct insert, a restore) cannot collide with every other codeless row on
-- NULL — the same shape 0237 used for threepl_companies.registration_no and
-- 0241 for workshops.
CREATE UNIQUE INDEX IF NOT EXISTS uq_threepl_companies_code
  ON scm.threepl_companies (company_id, code)
  WHERE code IS NOT NULL AND code <> '';
