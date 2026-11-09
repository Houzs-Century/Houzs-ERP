-- 20261109T1500_acc_finance_text_upper_case.sql
-- Finance keeps the words a person types in UPPER CASE (owner 2026-11-09: 「可以默认
-- 区别自动大写吗？不然感觉有些大写，有些小写，主要是finance 模块，这点可以确定」, then
-- 「做」 to: typed words saved upper case; the old rows converted once, their old
-- casing kept aside so it can be put back).
--
-- 1. scm.upper_typed_text(): a BEFORE INSERT OR UPDATE trigger function that
--    upper-cases the columns named in its arguments. One trigger per table, on the
--    columns a person types (inventory 2026-11-09): payee / party / payer / debtor /
--    supplier names, descriptions, remarks, purposes, reasons, bank names and
--    account names. Upper-casing changes letters only; numbers, dates, codes and
--    references are other columns and are not touched.
--    NOT here: the To do, the bank month locks, the Other Debtor receipt's notes (its
--    "[rejected]" marker is read back as written), and the journal tables — every
--    document writes its words there when it posts, and some of them are read back
--    as written (acc/payment-drift.ts). A hand-written journal's words are
--    upper-cased by its two routes instead (acc/typed-text.ts), and its old ones once
--    below.
-- 2. The old rows, once: each value not already upper case is copied into
--    scm.acc_text_case_backup (company, table, row id, column, old value), then
--    upper-cased. No trigger on these tables refuses or re-stamps such an update (the
--    one trigger there is, trg_je_balanced, only checks a journal being posted).
--
-- HOUSE STYLE. Idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: drop the triggers and the function, then put the old casing back from
--   the backup, per table and column, e.g.
--     DROP TRIGGER IF EXISTS upper_typed_text ON scm.payment_vouchers;   -- and each table below
--     DROP FUNCTION IF EXISTS scm.upper_typed_text();
--     UPDATE scm.payment_vouchers t SET notes = b.old_value FROM scm.acc_text_case_backup b
--      WHERE b.table_name = 'payment_vouchers' AND b.column_name = 'notes' AND b.row_id = t.id::text;
--   (journal_entries: narration; journal_entry_lines: notes.)

CREATE OR REPLACE FUNCTION scm.upper_typed_text() RETURNS trigger
LANGUAGE plpgsql SET search_path = scm, pg_temp AS $$
DECLARE
  col   text;
  rec   jsonb := to_jsonb(NEW);
  patch jsonb := '{}'::jsonb;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF jsonb_typeof(rec -> col) = 'string' AND (rec ->> col) <> upper(rec ->> col) THEN
      patch := patch || jsonb_build_object(col, upper(rec ->> col));
    END IF;
  END LOOP;
  IF patch <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, patch);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS scm.acc_text_case_backup (
  id          bigserial   PRIMARY KEY,
  company_id  bigint,
  table_name  text        NOT NULL,
  row_id      text        NOT NULL,
  column_name text        NOT NULL,
  old_value   text        NOT NULL,
  saved_at    timestamptz NOT NULL DEFAULT now()
);
-- Same as 20261026T1700: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.acc_text_case_backup ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.acc_text_case_backup TO service_role;
GRANT USAGE, SELECT ON SEQUENCE scm.acc_text_case_backup_id_seq TO service_role;

-- The old rows, once: back up, then upper-case. A value already upper case (or null)
-- is neither copied nor written.
DO $$
DECLARE
  t record;
  c text;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('payment_vouchers',      ARRAY['payee_name', 'notes', 'pay_to_bank_name', 'pay_to_account_name', 'official_doc_note']),
    ('payment_voucher_lines', ARRAY['description']),
    ('ap_invoices',           ARRAY['notes', 'official_doc_note']),
    ('ap_invoice_lines',      ARRAY['description']),
    ('acc_payment_requests',  ARRAY['payee_name', 'purpose', 'bank_name', 'bank_account_name', 'note', 'finance_note', 'no_event_reason']),
    ('acc_receipts',          ARRAY['payer_name', 'notes']),
    ('acc_receipt_lines',     ARRAY['description']),
    ('acc_credit_notes',      ARRAY['party_name', 'reason', 'notes']),
    ('acc_credit_note_lines', ARRAY['description']),
    ('acc_debtor_bills',      ARRAY['notes']),
    ('acc_debtor_bill_lines', ARRAY['description']),
    ('acc_debtors',           ARRAY['name']),
    ('suppliers',             ARRAY['name', 'bank_name', 'bank_account_name'])
  ) AS v(tbl, cols) LOOP
    FOREACH c IN ARRAY t.cols LOOP
      EXECUTE format(
        'INSERT INTO scm.acc_text_case_backup (company_id, table_name, row_id, column_name, old_value)
           SELECT company_id, %L, id::text, %L, %I FROM scm.%I WHERE %I <> upper(%I)',
        t.tbl, c, c, t.tbl, c, c);
      EXECUTE format('UPDATE scm.%I SET %I = upper(%I) WHERE %I <> upper(%I)', t.tbl, c, c, c, c);
    END LOOP;
  END LOOP;
END $$;

-- Hand-written journals only: every other journal's words are the posting documents'.
INSERT INTO scm.acc_text_case_backup (company_id, table_name, row_id, column_name, old_value)
  SELECT j.company_id, 'journal_entries', j.id::text, 'narration', j.narration
    FROM scm.journal_entries j
   WHERE j.source_type = 'MANUAL' AND j.narration <> upper(j.narration);
UPDATE scm.journal_entries SET narration = upper(narration)
 WHERE source_type = 'MANUAL' AND narration <> upper(narration);

INSERT INTO scm.acc_text_case_backup (company_id, table_name, row_id, column_name, old_value)
  SELECT l.company_id, 'journal_entry_lines', l.id::text, 'notes', l.notes
    FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
   WHERE j.source_type = 'MANUAL' AND l.notes <> upper(l.notes);
UPDATE scm.journal_entry_lines l SET notes = upper(l.notes)
  FROM scm.journal_entries j
 WHERE j.id = l.journal_entry_id AND j.source_type = 'MANUAL' AND l.notes <> upper(l.notes);

-- From now on: each table upper-cases its typed columns on every insert, and on an
-- update that writes one of them.
DROP TRIGGER IF EXISTS upper_typed_text ON scm.payment_vouchers;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF payee_name, notes, pay_to_bank_name, pay_to_account_name, official_doc_note ON scm.payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('payee_name', 'notes', 'pay_to_bank_name', 'pay_to_account_name', 'official_doc_note');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.payment_voucher_lines;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF description ON scm.payment_voucher_lines
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('description');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.ap_invoices;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF notes, official_doc_note ON scm.ap_invoices
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('notes', 'official_doc_note');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.ap_invoice_lines;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF description ON scm.ap_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('description');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_payment_requests;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF payee_name, purpose, bank_name, bank_account_name, note, finance_note, no_event_reason ON scm.acc_payment_requests
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('payee_name', 'purpose', 'bank_name', 'bank_account_name', 'note', 'finance_note', 'no_event_reason');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_receipts;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF payer_name, notes ON scm.acc_receipts
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('payer_name', 'notes');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_receipt_lines;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF description ON scm.acc_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('description');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_credit_notes;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF party_name, reason, notes ON scm.acc_credit_notes
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('party_name', 'reason', 'notes');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_credit_note_lines;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF description ON scm.acc_credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('description');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_debtor_bills;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF notes ON scm.acc_debtor_bills
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('notes');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_debtor_bill_lines;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF description ON scm.acc_debtor_bill_lines
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('description');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.acc_debtors;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF name ON scm.acc_debtors
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('name');

DROP TRIGGER IF EXISTS upper_typed_text ON scm.suppliers;
CREATE TRIGGER upper_typed_text
  BEFORE INSERT OR UPDATE OF name, bank_name, bank_account_name ON scm.suppliers
  FOR EACH ROW EXECUTE FUNCTION scm.upper_typed_text('name', 'bank_name', 'bank_account_name');

NOTIFY pgrst, 'reload schema';
