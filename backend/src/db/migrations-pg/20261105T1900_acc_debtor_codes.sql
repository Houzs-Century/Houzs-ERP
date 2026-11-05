-- 20261105T1900_acc_debtor_codes.sql
-- An account code for every other debtor, AutoCount style (owner 2026-11-03,
-- f3 「要」 on the Finance redesign, batch 5 step 11): 305-A001, 305-A002 …
-- the debtor control's own number, the first letter (or digit) of the name,
-- then the next three-digit number among the company's codes with that letter.
-- AutoCount numbers 2990 HOME 305-2001, so a name that starts with a digit
-- takes the digit.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   1. One nullable text column, scm.acc_debtors.code.
--   2. One partial unique index: no two debtors of a company share a code.
--   3. The fill, ONCE: every debtor whose code is NULL gets its suggested code.
--      Deterministic — per company, prefix and letter, the next number after
--      the highest code already taken, in the order the debtors were created
--      (then by name, then by id); never touches a code that is already set,
--      so a re-run fills nothing. A name with no letter or digit in it keeps
--      NULL until someone types a code on the form.
--   The codes are for screens and prints ONLY: no journal line, party field or
--   posting rule reads them. Bills and receipts keep posting to the AR_OTHER
--   control (305-0000) exactly as before. Codes stay editable on the debtor's
--   form (PATCH /other-debtors/:id).
--
-- REVERSAL:
--   Revert the code first (scm/routes/other-debtors.ts writes and reads it;
--   ar-invoices.ts, receipts.ts and credit-notes.ts read it).
--   DROP INDEX IF EXISTS scm.acc_debtors_company_code_key;
--   ALTER TABLE scm.acc_debtors DROP COLUMN IF EXISTS code;
--   GRANTS: none — a column and an index on an existing table ride its grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_debtors
  ADD COLUMN IF NOT EXISTS code text;

CREATE UNIQUE INDEX IF NOT EXISTS acc_debtors_company_code_key
  ON scm.acc_debtors (company_id, code)
  WHERE code IS NOT NULL;

-- The fill. The prefix is the number before the dash of the company's AR_OTHER
-- control (305-0000 when the company has no role row); the letter is the first
-- A-Z or 0-9 of the upper-cased name.
WITH todo AS (
  SELECT d.id,
         d.company_id,
         split_part(COALESCE(NULLIF(btrim(r.account_code), ''), '305-0000'), '-', 1)
           || '-' || substring(upper(d.name) FROM '[A-Z0-9]') AS stem,
         d.created_at,
         upper(d.name) AS sort_name
    FROM scm.acc_debtors d
    LEFT JOIN scm.acc_account_roles r
      ON r.company_id = d.company_id AND r.role = 'AR_OTHER'
   WHERE d.code IS NULL
     AND substring(upper(d.name) FROM '[A-Z0-9]') IS NOT NULL
),
taken AS (
  SELECT t.company_id,
         substring(t.code FROM '^(.*-[A-Z0-9])[0-9]{3,}$') AS stem,
         max(substring(t.code FROM '^.*-[A-Z0-9]([0-9]{3,})$')::bigint) AS top
    FROM scm.acc_debtors t
   WHERE t.code ~ '^.*-[A-Z0-9][0-9]{3,}$'
   GROUP BY 1, 2
),
numbered AS (
  SELECT todo.id,
         todo.stem,
         COALESCE(taken.top, 0)
           + row_number() OVER (PARTITION BY todo.company_id, todo.stem
                                ORDER BY todo.created_at, todo.sort_name, todo.id) AS n
    FROM todo
    LEFT JOIN taken
      ON taken.company_id = todo.company_id AND taken.stem = todo.stem
)
UPDATE scm.acc_debtors d
   SET code = numbered.stem
              || CASE WHEN numbered.n < 1000 THEN lpad(numbered.n::text, 3, '0') ELSE numbered.n::text END
  FROM numbered
 WHERE d.id = numbered.id
   AND d.code IS NULL;
