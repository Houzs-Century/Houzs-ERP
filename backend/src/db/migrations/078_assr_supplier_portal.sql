-- 078_assr_supplier_portal.sql
--
-- ASSR/QMS v3.1 — Phase F: Supplier Portal.
--
-- Suppliers in this codebase are AutoCount creditor rows, not users.
-- The Customer Portal (mig 017) gives the END CUSTOMER a token-scoped
-- view of their case. We need the mirror flow for SUPPLIERS so a
-- supplier rep can see the job assigned to them, mark pickup / repair
-- / ready / delivered, and upload QC photos — without granting them
-- credentials in the main app.
--
-- Tokens are scoped to (case, creditor_code) and have a configurable
-- TTL. Multiple tokens per case are allowed so a supplier rep can
-- have a long-lived token while a one-off email link uses a short
-- TTL.

CREATE TABLE assr_supplier_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  assr_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  creditor_code TEXT,                 -- scopes the token to a specific supplier; NULL = any supplier
  expires_at TEXT,                    -- ISO timestamp; NULL = no expiry
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_assr_supplier_tokens_case  ON assr_supplier_tokens(assr_id);
CREATE INDEX idx_assr_supplier_tokens_token ON assr_supplier_tokens(token);
