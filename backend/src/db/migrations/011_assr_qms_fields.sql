-- 011_assr_qms_fields.sql
-- QMS additions: manager sign-off, NCR classification, cost tracking.

-- Manager approval / quality review
ALTER TABLE assr_cases ADD COLUMN approved_by INTEGER;
ALTER TABLE assr_cases ADD COLUMN approved_at TEXT;
ALTER TABLE assr_cases ADD COLUMN quality_review_passed INTEGER; -- 0/1 nullable

-- NCR (Non-Conformance Report) classification. Free-text on purpose so
-- ops can evolve the taxonomy without migrations; common values:
--   'material_defect' | 'workmanship' | 'transit_damage' | 'design'
--   | 'installation' | 'customer_misuse' | 'other'
ALTER TABLE assr_cases ADD COLUMN ncr_category TEXT;

-- Cost tracking
ALTER TABLE assr_cases ADD COLUMN po_amount REAL;            -- PO cost issued to supplier
ALTER TABLE assr_cases ADD COLUMN supplier_invoice_ref TEXT; -- External invoice number
ALTER TABLE assr_cases ADD COLUMN cost_notes TEXT;           -- Price adjustments, reconciliation notes

CREATE INDEX IF NOT EXISTS idx_assr_approved_by ON assr_cases(approved_by);
CREATE INDEX IF NOT EXISTS idx_assr_ncr ON assr_cases(ncr_category);
