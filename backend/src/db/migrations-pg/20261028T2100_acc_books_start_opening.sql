-- REVERSAL: UPDATE scm.acc_company_settings SET books_start_date = NULL turns
--   the rule off for every report at once (the views then read as before). A
--   full revert re-runs v_account_balances' block from 20260915T1400 and
--   v_gl_entries' from 0306 with `j.opening` kept as its last column (REPLACE
--   cannot drop an appended column, and a DROP VIEW would lose the ACL — see
--   0306); then ALTER TABLE scm.acc_company_settings DROP COLUMN
--   books_start_date, opening_stock, opening_locked_at, opening_locked_by is
--   only possible once v_gl_entries no longer names `opening`. No data is
--   written here: the opening import sets books_start_date and the flags in
--   its own transaction. The flag columns (journal_entries, ap_invoices,
--   acc_credit_notes, acc_debtor_bills, acc_debtor_receipts) drop with
--   ALTER TABLE … DROP COLUMN opening once the views no longer name it.
--
-- WHY. Houzs (company 1) opens its books in the ERP on 01/09/2026 (owner
--   2026-10-06: 开账放01/09). Up to 31/08 AutoCount is the book of record; what
--   the ERP holds dated before 01/09 is the soft launch (owner 2026-10-28:
--   「我在31/08 都在auto count做，31/08 之前我都是soft launch 的。我会在01/09/2026
--   当做正式在erp做，所以账的opening也是01/09/2026」) — 109 posted journals:
--   the July and August stock closes, payments keyed later under old dates, a
--   few August bills. They stay on file; the books do not count them. The
--   opening (AutoCount's 31/08 balances) stands in their place.
--
-- WHAT. A company with books_start_date set counts, in its two report views,
--   only journals dated on or after that day — plus every journal flagged
--   `opening`, whatever its date (an opening bill keeps its own invoice date so
--   the aging reads its age) — and never a stock close of a month before the
--   start: STOCKADJ-{co}-{YYYY-MM} is dated the month's last day, but its
--   STOCKADJ-REV-…-{YYYY-MM} opening leg lands on the first of the next month,
--   which would otherwise carry the soft launch's August stock into September.
--   A company without the setting reads exactly as before.
--
--   opening_stock is the stock the books opened with, per bucket, in sen
--   ({"customer": n, …}): September's opening stock comes from it instead of
--   the stock engine (owner 2026-10-28: 「1744164.68就当01/09 的opening stock,
--   然后每天算closing stock 就可以了」). opening_locked_* freezes the Opening
--   Balance page once the owner calls 31/08 final.
--
-- SHAPE. CREATE OR REPLACE VIEW may only APPEND columns (0290 stopped a
--   production deploy learning it): both SELECT lists are copied verbatim from
--   the live definitions; v_gl_entries appends `opening` at the end and
--   nothing else moves. REPLACE keeps the views' ACLs.
--
-- Verified against: tests-pg/booksStart.pg.test.ts (postgres:16) — the pre
--   state counts the soft launch; after, it counts the opening and September
--   only, the shapes of both views are unchanged but for the appended column.

SET search_path = scm, public;

ALTER TABLE scm.acc_company_settings
  ADD COLUMN IF NOT EXISTS books_start_date  date,
  ADD COLUMN IF NOT EXISTS opening_stock     jsonb,
  ADD COLUMN IF NOT EXISTS opening_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS opening_locked_by text;

ALTER TABLE scm.journal_entries  ADD COLUMN IF NOT EXISTS opening boolean NOT NULL DEFAULT false;
ALTER TABLE scm.ap_invoices      ADD COLUMN IF NOT EXISTS opening boolean NOT NULL DEFAULT false;
ALTER TABLE scm.acc_credit_notes ADD COLUMN IF NOT EXISTS opening boolean NOT NULL DEFAULT false;
ALTER TABLE scm.acc_debtor_bills ADD COLUMN IF NOT EXISTS opening boolean NOT NULL DEFAULT false;
-- An other debtor AutoCount owes (a credit balance) opens as a receipt not yet
-- knocked off — the one paper that holds a debtor's credit.
ALTER TABLE scm.acc_debtor_receipts ADD COLUMN IF NOT EXISTS opening boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW scm.v_gl_entries AS
 SELECT l.id AS line_id,
    j.je_no,
    j.entry_date,
    j.source_type,
    j.source_doc_no,
    l.line_no,
    l.account_code,
    a.account_name,
    a.account_type,
    l.debit_sen,
    l.credit_sen,
    l.party_type,
    l.party_code,
    l.party_name,
    l.notes,
    j.posted,
    j.posted_at,
    j.company_id,
    j.reversed,
    j.reversed_by_je,
    -- APPENDED: the opening's own journals, counted whatever their date.
    j.opening
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     -- BOTH halves of the composite key 0188 created. On account_code alone this
     -- matched the other company's identically-coded account and returned every
     -- line twice.
     JOIN scm.accounts a
       ON a.account_code = l.account_code
      AND a.company_id = j.company_id
     -- The day the company's books start (a soft launch before it is not in the books).
     LEFT JOIN scm.acc_company_settings bs ON bs.company_id = j.company_id
  WHERE j.posted = true
    AND (bs.books_start_date IS NULL
      OR j.opening
      OR (j.entry_date >= bs.books_start_date
          AND NOT (j.source_type IN ('STOCKADJ', 'STOCKADJ_REVERSAL')
                   AND substring(j.source_doc_no FROM '([0-9]{4}-[0-9]{2})$') < to_char(bs.books_start_date, 'YYYY-MM'))))
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;

CREATE OR REPLACE VIEW scm.v_account_balances AS
 SELECT a.account_code,
    a.account_name,
    a.account_type,
    COALESCE(sum(l.debit_sen), 0::bigint) AS total_debit_sen,
    COALESCE(sum(l.credit_sen), 0::bigint) AS total_credit_sen,
        CASE
            WHEN a.account_type = ANY (ARRAY['ASSET'::text, 'EXPENSE'::text]) THEN COALESCE(sum(l.debit_sen), 0::bigint) - COALESCE(sum(l.credit_sen), 0::bigint)
            ELSE COALESCE(sum(l.credit_sen), 0::bigint) - COALESCE(sum(l.debit_sen), 0::bigint)
        END AS balance_sen,
    a.company_id
   FROM scm.accounts a
     -- The lines the books count, chosen BEFORE the outer join: posted, on
     -- neither side of a reversal pair, and inside the company's books (the
     -- same start-date rule as v_gl_entries above).
     LEFT JOIN (
       SELECT l.account_code, l.company_id, l.debit_sen, l.credit_sen
         FROM scm.journal_entry_lines l
         JOIN scm.journal_entries j ON j.id = l.journal_entry_id
         LEFT JOIN scm.acc_company_settings bs ON bs.company_id = j.company_id
        WHERE j.posted = true
          AND j.reversed = false
          AND j.reversed_by_je IS NULL
          AND (bs.books_start_date IS NULL
            OR j.opening
            OR (j.entry_date >= bs.books_start_date
                AND NOT (j.source_type IN ('STOCKADJ', 'STOCKADJ_REVERSAL')
                         AND substring(j.source_doc_no FROM '([0-9]{4}-[0-9]{2})$') < to_char(bs.books_start_date, 'YYYY-MM'))))
     ) l
       ON l.account_code = a.account_code
      AND l.company_id = a.company_id
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;
