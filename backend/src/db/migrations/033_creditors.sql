-- 033_creditors.sql
-- Local mirror of AutoCount /Creditor/getAll. The local `suppliers`
-- table is intentionally NOT linked here — this is the procurement-
-- creditor side and AutoCount stays the system of record. We mirror
-- so the UI can search and list quickly without round-tripping
-- AutoCount on every request.
--
-- Field naming follows the upstream payload (all `Creditor*`
-- prefixed). `is_active` defaults to 1 because /getAll doesn't expose
-- an active flag — kept for forward-compat in case future endpoint
-- versions add one.

CREATE TABLE IF NOT EXISTS creditors (
  creditor_code              TEXT PRIMARY KEY,
  company_name               TEXT,    -- CreditorCompanyName (display name)
  desc2                      TEXT,    -- CreditorDesc2 (alt name)

  -- Billing address
  address1                   TEXT,
  address2                   TEXT,
  address3                   TEXT,
  address4                   TEXT,
  post_code                  TEXT,

  -- Delivery address (often same as billing but kept distinct)
  deliver_address1           TEXT,
  deliver_address2           TEXT,
  deliver_address3           TEXT,
  deliver_address4           TEXT,
  deliver_post_code          TEXT,

  -- Contact
  attention                  TEXT,
  phone1                     TEXT,
  phone2                     TEXT,
  mobile                     TEXT,
  fax1                       TEXT,
  fax2                       TEXT,
  email                      TEXT,
  web_url                    TEXT,
  contact_info               TEXT,    -- CreditorContactInfo
  nature_of_business         TEXT,

  -- Commercial / financial
  currency_code              TEXT,
  display_term               TEXT,
  rounding_method            TEXT,
  inclusive_tax              INTEGER,
  price_category             TEXT,
  statement_type             TEXT,
  aging_on                   TEXT,
  credit_limit               REAL,
  overdue_limit              REAL,

  -- Tax / regulatory
  tax_code                   TEXT,
  tax_register_no            TEXT,
  gst_register_no            TEXT,
  sst_register_no            TEXT,
  self_billed_approval_no    TEXT,
  exempt_no                  TEXT,
  exempt_expiry_date         TEXT,
  register_no                TEXT,
  gst_status_verified_date   TEXT,

  -- Classification
  area_code                  TEXT,
  area_description           TEXT,
  area_desc2                 TEXT,
  type                       TEXT,
  type_description           TEXT,
  type_desc2                 TEXT,
  purchase_agent             TEXT,
  purchase_agent_description TEXT,
  parent_acc_no              TEXT,

  -- Notes
  note                       TEXT,

  -- Audit
  last_modified              TEXT,
  last_modified_user_id      TEXT,
  created_timestamp          TEXT,
  created_user_id            TEXT,

  -- Forward-compat / convenience
  is_active                  INTEGER DEFAULT 1,
  raw                        TEXT,
  created_at                 TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_creditors_company_name ON creditors(company_name);
CREATE INDEX IF NOT EXISTS idx_creditors_currency ON creditors(currency_code);
CREATE INDEX IF NOT EXISTS idx_creditors_type ON creditors(type);
