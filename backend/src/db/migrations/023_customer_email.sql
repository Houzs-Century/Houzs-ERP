-- 023_customer_email.sql
-- Adds customer_email to assr_cases so the satisfaction survey link
-- can be auto-mailed on case close. Opt-in: absent email simply means
-- "no survey email" — the logged activity + manual link regen flow
-- still work as before.

ALTER TABLE assr_cases ADD COLUMN customer_email TEXT;
CREATE INDEX IF NOT EXISTS idx_assr_customer_email ON assr_cases(customer_email);
