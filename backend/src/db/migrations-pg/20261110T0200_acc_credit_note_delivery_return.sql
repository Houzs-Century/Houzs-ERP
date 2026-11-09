-- 20261110T0200_acc_credit_note_delivery_return.sql
--
-- REVERSAL:
--   DROP TRIGGER IF EXISTS acc_credit_note_lines_return_cap ON scm.acc_credit_note_lines;
--   DROP FUNCTION IF EXISTS scm.acc_credit_note_return_cap();
--   ALTER TABLE scm.acc_credit_note_lines DROP CONSTRAINT IF EXISTS acc_credit_note_lines_return_qty;
--   ALTER TABLE scm.acc_credit_note_lines DROP COLUMN IF EXISTS delivery_return_item_id, DROP COLUMN IF EXISTS qty;
--   ALTER TABLE scm.acc_credit_notes DROP COLUMN IF EXISTS delivery_return_id;
--   No data is lost that existed before this file: every column is new and
--   nullable, nothing is back-filled. Notes raised from a return after it keep
--   their money and journal; only the link back to the return goes.
--
-- WHAT THIS IS. A customer credit note raised from a Delivery Return (backlog
-- A1; Hookka #952 / #956 / #959). The note names the return it answers, and
-- each line names the return line it credits and how many units. A return
-- line may never be credited for more units than came back, counted over every
-- note that is not CANCELLED — enforced here, under a row lock on the return
-- line, so two notes saved at the same moment cannot both take the last unit.
-- The route says the same thing first, in words (scm/lib/cn-from-return.ts).
--
-- Reversal / Verified against: in the PR body, where the check reads them.

ALTER TABLE scm.acc_credit_notes
  ADD COLUMN IF NOT EXISTS delivery_return_id uuid REFERENCES scm.delivery_returns (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_company_dr
  ON scm.acc_credit_notes (company_id, delivery_return_id) WHERE delivery_return_id IS NOT NULL;

ALTER TABLE scm.acc_credit_note_lines
  ADD COLUMN IF NOT EXISTS delivery_return_item_id uuid REFERENCES scm.delivery_return_items (id) ON DELETE SET NULL;
ALTER TABLE scm.acc_credit_note_lines
  ADD COLUMN IF NOT EXISTS qty integer;
ALTER TABLE scm.acc_credit_note_lines DROP CONSTRAINT IF EXISTS acc_credit_note_lines_return_qty;
ALTER TABLE scm.acc_credit_note_lines ADD CONSTRAINT acc_credit_note_lines_return_qty
  CHECK (qty IS NULL OR qty > 0);
-- A return line deleted after its note was cancelled leaves the line's qty as
-- history with no link (ON DELETE SET NULL); the route refuses deleting a line
-- a LIVE note still credits.
CREATE INDEX IF NOT EXISTS idx_acc_credit_note_lines_dr_item
  ON scm.acc_credit_note_lines (delivery_return_item_id) WHERE delivery_return_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION scm.acc_credit_note_return_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = scm, public
AS $$
DECLARE
  returned integer;
  taken    integer;
BEGIN
  IF NEW.delivery_return_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.qty IS NULL THEN
    RAISE EXCEPTION 'credit_note_return_qty_required: a line naming return line % carries no qty', NEW.delivery_return_item_id
      USING ERRCODE = '23502';
  END IF;
  SELECT qty_returned INTO returned
    FROM scm.delivery_return_items
   WHERE id = NEW.delivery_return_item_id AND company_id = NEW.company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_note_return_line_unknown: return line % is not in company %', NEW.delivery_return_item_id, NEW.company_id
      USING ERRCODE = '23503';
  END IF;
  SELECT COALESCE(SUM(l.qty), 0) INTO taken
    FROM scm.acc_credit_note_lines l
    JOIN scm.acc_credit_notes n ON n.id = l.note_id
   WHERE l.delivery_return_item_id = NEW.delivery_return_item_id
     AND n.status <> 'CANCELLED'
     AND l.id <> NEW.id;
  IF taken + NEW.qty > returned THEN
    RAISE EXCEPTION 'over_return_credit: return line % has % returned and % already credited; % more refused', NEW.delivery_return_item_id, returned, taken, NEW.qty
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acc_credit_note_lines_return_cap ON scm.acc_credit_note_lines;
CREATE TRIGGER acc_credit_note_lines_return_cap
  BEFORE INSERT OR UPDATE OF delivery_return_item_id, qty ON scm.acc_credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION scm.acc_credit_note_return_cap();

COMMENT ON COLUMN scm.acc_credit_notes.delivery_return_id IS
  'The delivery return a customer credit note answers (backlog A1). Its lines name the return lines and units.';
COMMENT ON COLUMN scm.acc_credit_note_lines.delivery_return_item_id IS
  'The return line this credit line is for; with qty. Capped by trigger acc_credit_note_lines_return_cap at the units returned over every non-cancelled note.';
