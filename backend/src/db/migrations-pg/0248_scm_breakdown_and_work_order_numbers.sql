-- 0248 — breakdown cases and work orders get numbers you can say out loud.
--
-- WHY. Owner, 2026-08-03: "每一个 Breakdown Incident 应该带出一个唯一的编号" and
-- "你的 Works Order 也应该有一个编号... 需要清晰指示它对应的是哪一个 Breakdown
-- 编号".
--
-- Both tables have only a UUID. The number the owner sees on screen today —
-- WJO00403 — is the WORKSHOP'S OWN quotation number, read off their document by
-- the OCR (quotation_no, mig 0241). It belongs to the vendor, it is not unique
-- across vendors, and a repair with no document has none at all. There is
-- currently no way to refer to one of our own records except by pointing at it.
--
-- BD-#### and WO-####, per company, minted by the routes with the same
-- fleet-code minter that allocates DRV / LRY / 3PL / WS codes
-- (scm/lib/fleet-code-mint.ts) — one parser, one padding rule, one place where
-- "what comes after the highest" is decided.
--
-- THE BACKFILL IS DETERMINISTIC AND HISTORICAL. Rows are numbered per company by
-- (created_at, id) — oldest first — so the numbers read like a register and
-- re-running the migration on a clone produces the same answer. id is the
-- tiebreak because two rows can share a created_at.
--
-- NULLABLE + PARTIAL UNIQUE, like mig 0242 did for threepl_companies. A NOT NULL
-- with a default cannot express "allocated by the route", and a plain UNIQUE
-- would collide on the NULLs of any row a future path forgets to number. The
-- index is per company because two companies numbering from 1 is correct.
--
-- NO SEQUENCE. A Postgres sequence would be gapless-ish and concurrent, but it
-- lives outside the app's own allocation rule and cannot be reasoned about from
-- the code that mints the other four fleet codes. Consistency with the codes
-- already in production is worth more here than concurrency this table will
-- never see — a lorry breaks down a few times a year, not a few times a second.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, one transaction.
-- RE-CHECK THE NUMBER AT MERGE — 0248 was next free above 0247.

SET search_path = scm, public;

ALTER TABLE scm.lorry_breakdown_cases ADD COLUMN IF NOT EXISTS case_no TEXT NULL;
ALTER TABLE scm.lorry_work_orders     ADD COLUMN IF NOT EXISTS wo_no   TEXT NULL;

UPDATE scm.lorry_breakdown_cases b
   SET case_no = 'BD-' || LPAD(seq.rn::TEXT, 4, '0')
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id) AS rn
      FROM scm.lorry_breakdown_cases
     WHERE case_no IS NULL
  ) seq
 WHERE b.id = seq.id
   AND b.case_no IS NULL;

UPDATE scm.lorry_work_orders w
   SET wo_no = 'WO-' || LPAD(seq.rn::TEXT, 4, '0')
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id) AS rn
      FROM scm.lorry_work_orders
     WHERE wo_no IS NULL
  ) seq
 WHERE w.id = seq.id
   AND w.wo_no IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lorry_breakdown_cases_case_no_uq
  ON scm.lorry_breakdown_cases (company_id, case_no)
  WHERE case_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lorry_work_orders_wo_no_uq
  ON scm.lorry_work_orders (company_id, wo_no)
  WHERE wo_no IS NOT NULL;
