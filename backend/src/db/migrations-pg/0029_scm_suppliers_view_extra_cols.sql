-- 0029_scm_suppliers_view_extra_cols.sql — flow the 0028 supplier columns through
-- the suppliers list view. The list endpoint selects SUPPLIER_COLS (which now
-- includes registration_no / nature_of_business / exemption_no / phone2) FROM
-- scm.suppliers_with_derived_category — but that view (created by the original
-- schema dump, NOT a migration) had a fixed column list predating 0028, so the
-- list 500'd: "column suppliers_with_derived_category.registration_no does not
-- exist". Recreate the view with the 4 new columns appended (after
-- derived_category so CREATE OR REPLACE keeps the existing column order).
-- Single statement (no internal ';\n'); all refs schema-qualified to scm.*.
CREATE OR REPLACE VIEW scm.suppliers_with_derived_category AS
SELECT s.id, s.code, s.name, s.whatsapp_number, s.email, s.contact_person, s.phone, s.address, s.state, s.country, s.payment_terms, s.status, s.rating, s.notes, s.supplier_type, s.category, s.tin_number, s.business_reg_no, s.postcode, s.area, s.mobile, s.fax, s.website, s.attention, s.business_nature, s.currency, s.statement_type, s.aging_basis, s.credit_limit_sen, s.created_at, s.updated_at,
  ( SELECT CASE
        WHEN count(DISTINCT mp.category) = 0 THEN NULL::text
        WHEN count(DISTINCT mp.category) = 1 THEN max(mp.category::text)
        ELSE 'MIXED'::text
      END
    FROM scm.supplier_material_bindings smb
      LEFT JOIN scm.mfg_products mp ON mp.code = smb.material_code AND smb.material_kind = 'mfg_product'::scm.material_kind
    WHERE smb.supplier_id = s.id) AS derived_category,
  s.registration_no, s.nature_of_business, s.exemption_no, s.phone2
FROM scm.suppliers s;
