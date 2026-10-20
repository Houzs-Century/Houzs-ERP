-- Owner, 2026-10-15: an in-house lorry keeps its Geran (registration card) on
-- file in Fleet Health. It has no expiry, so it never reminds and never grounds.
-- APAD and CROSS_BORDER stay allowed so rows filed before still read.
-- REVERSAL: ALTER TABLE scm.lorry_compliance_documents DROP CONSTRAINT IF EXISTS lorry_compliance_documents_doc_type_check; ALTER TABLE scm.lorry_compliance_documents ADD CONSTRAINT lorry_compliance_documents_doc_type_check CHECK (doc_type IN ('PUSPAKOM','ROAD_TAX','INSURANCE','APAD','CROSS_BORDER'));  -- only after deleting any GERAN rows
ALTER TABLE scm.lorry_compliance_documents DROP CONSTRAINT IF EXISTS lorry_compliance_documents_doc_type_check;
ALTER TABLE scm.lorry_compliance_documents ADD CONSTRAINT lorry_compliance_documents_doc_type_check
  CHECK (doc_type IN ('PUSPAKOM','ROAD_TAX','INSURANCE','GERAN','APAD','CROSS_BORDER'));
