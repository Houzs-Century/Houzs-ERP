-- 0241 — Workshop master + the repair-record shape a real workshop invoice has.
--
-- WHY. Owner, 2026-08-02, with a real document (T FORCE AUTO SERVICES SDN BHD,
-- quotation WJO00403, lorry VQE9058, RM22,208.50): "我们每次做罗里维修都必须要
-- 有完整的记录... 每一次维修算作一条独立记录". Read against that document, the
-- 0204 work-order tables cannot hold it:
--
--   * the vendor is a free-text `workshop` string on FOUR unrelated tables
--     (lorry_work_orders, lorry_breakdown_cases, lorry_maintenance_plans,
--     lorry_service_records), so "what did we spend at T FORCE this year" is
--     not a question the schema can answer;
--   * `quote_refs` / `invoice_refs` hold R2 FILE KEYS, not the vendor's document
--     NUMBERS — there was nowhere to put "WJO00403";
--   * a line had name / part_no / qty / unit_price and NOTHING ELSE: no UOM
--     (the document uses PC, UNIT, SET and LIT), no discount (14 of its 19
--     lines carry 15%), and no line amount;
--   * labour was ONE scalar on the header (`labour_centi`), but the document
--     bills labour as its own SECTION of line items.
--
-- WORKSHOP IS ITS OWN MASTER, NOT A SUPPLIER. scm.suppliers is the goods master
-- — it feeds purchase orders, GRNs, the DP supplier-pickup picker and the
-- supplier portal. A workshop you send a lorry to is none of those, and filing
-- it there would put it in every PO party list. This follows the precedent
-- 0210 set for scm.threepl_companies, which is a separate master for exactly
-- the same reason.
--
-- DISCOUNT IS A PERCENTAGE, AND THE AMOUNT IS STORED, NOT DERIVED. The document
-- prints Qty x Unit Price x (1 - Dis%) per line and that reproduces its total
-- exactly (verified line by line against WJO00403). But the printed amount is a
-- FACT FROM AN EXTERNAL DOCUMENT, not a derivation we own: the vendor's own
-- rounding is theirs, and a record that silently disagrees with the paper is
-- worse than one that stores what the paper said. So amount_centi is stored and
-- NULLABLE — null means "no printed amount, compute it" — and the reader takes
-- `amount_centi ?? round(qty * unit_price * (1 - discount_pct/100))`.
--
-- LABOUR: BOTH SHAPES COEXIST, AND MUST NOT BE SUMMED TWICE. Existing rows put
-- labour in lorry_work_orders.labour_centi. New records put it in LABOUR-section
-- lines. The header scalar keeps its DEFAULT 0, so a record that uses lines
-- leaves it 0 and the total is Σlines + labour_centi + outside + towing + tax
-- with no double count. The route is the single writer that enforces this; a
-- CHECK cannot express "not both" without pinning the rows that already exist.
--
-- BACKFILL — deliberately none. Every existing work order keeps its free-text
-- `workshop`; nothing can attribute those strings to a workshop row without a
-- human saying which is which, and inventing the mapping would fabricate spend
-- attribution. workshop_id stays NULL until someone links it.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0241 was next free above 0240.

SET search_path = scm, public;

-- ── 1. Workshop master ───────────────────────────────────────────────────────
-- All particulars nullable except the name: a kampung workshop with a phone
-- number and no SSM still repairs your lorry, and refusing to record it would
-- push that spend back into free text, which is the problem being fixed.
CREATE TABLE IF NOT EXISTS scm.workshops (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      BIGINT NOT NULL REFERENCES public.companies(id),
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  registration_no TEXT NULL,
  contact_name    TEXT NULL,
  contact_phone   TEXT NULL,
  office_phone    TEXT NULL,
  email           TEXT NULL,
  address         TEXT NULL,
  notes           TEXT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID NULL,
  updated_by      UUID NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workshops_name_uq UNIQUE (company_id, name),
  CONSTRAINT workshops_code_uq UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_workshops_company
  ON scm.workshops (company_id, is_active);

-- SSM is unique WHEN GIVEN. Partial so the many workshops without one do not
-- collide on NULL — same shape 0237 used for threepl_companies.registration_no.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workshops_registration_no
  ON scm.workshops (company_id, registration_no)
  WHERE registration_no IS NOT NULL AND registration_no <> '';

-- ── 2. The repair record's header: who billed it, and under what number ──────
ALTER TABLE scm.lorry_work_orders
  ADD COLUMN IF NOT EXISTS workshop_id   UUID NULL
    REFERENCES scm.workshops(id) ON DELETE SET NULL,
  -- The vendor's own document numbers. A single repair carries BOTH over its
  -- life — the quotation arrives at DIAGNOSED/APPROVED and the invoice at
  -- COMPLETED/VERIFIED — so they are two columns on one record, not two records.
  ADD COLUMN IF NOT EXISTS quotation_no  TEXT NULL,
  ADD COLUMN IF NOT EXISTS invoice_no    TEXT NULL,
  -- The workshop's service advisor ("Advisor: JEFF" on WJO00403). Their name,
  -- not ours — free text, because it is whoever the workshop put on the paper.
  ADD COLUMN IF NOT EXISTS advisor       TEXT NULL,
  -- The date PRINTED on the vendor document, which is not reported_at.
  ADD COLUMN IF NOT EXISTS document_date DATE NULL;

CREATE INDEX IF NOT EXISTS idx_lorry_work_orders_workshop
  ON scm.lorry_work_orders (workshop_id);

-- Finding a repair by the number the workshop quoted is the lookup an operator
-- actually performs, and it is how a re-uploaded document is recognised as one
-- already on file. Partial: most legacy rows have neither number.
CREATE INDEX IF NOT EXISTS idx_lorry_work_orders_quotation_no
  ON scm.lorry_work_orders (company_id, quotation_no)
  WHERE quotation_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lorry_work_orders_invoice_no
  ON scm.lorry_work_orders (company_id, invoice_no)
  WHERE invoice_no IS NOT NULL;

-- ── 3. The line items, as the document actually prints them ─────────────────
ALTER TABLE scm.lorry_work_order_parts
  -- Which SECTION of the invoice the line sat under. WJO00403 has "Part
  -- Charges" and "Labour Charges" and restarts its numbering in each.
  ADD COLUMN IF NOT EXISTS section       TEXT NOT NULL DEFAULT 'PART',
  ADD COLUMN IF NOT EXISTS uom           TEXT NULL,
  ADD COLUMN IF NOT EXISTS discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- The printed line total. NULL = not printed, compute it. See the header note.
  ADD COLUMN IF NOT EXISTS amount_centi  BIGINT NULL,
  -- The number the document gives the line, so a stored record can be read
  -- side by side with the paper it came from.
  ADD COLUMN IF NOT EXISTS line_no       INTEGER NULL;

DO $$ BEGIN
  ALTER TABLE scm.lorry_work_order_parts
    ADD CONSTRAINT lorry_wo_parts_section_chk CHECK (section IN ('PART','LABOUR'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE scm.lorry_work_order_parts
    ADD CONSTRAINT lorry_wo_parts_discount_chk
      CHECK (discount_pct >= 0 AND discount_pct <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE scm.lorry_work_order_parts
    ADD CONSTRAINT lorry_wo_parts_amount_chk CHECK (amount_centi IS NULL OR amount_centi >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reading a record back in document order.
CREATE INDEX IF NOT EXISTS idx_lorry_wo_parts_order
  ON scm.lorry_work_order_parts (work_order_id, section, line_no);
