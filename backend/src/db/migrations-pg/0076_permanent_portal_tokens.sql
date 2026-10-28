-- 0076_permanent_portal_tokens.sql
-- Staff-issued customer links and sales links are permanent now
-- (Nick 2026-07-07: shared WhatsApp links must keep working forever).
-- New tokens are minted with the far-future stamp; this extends every
-- existing staff/sales token the same way. Customer /track tokens
-- (30-min self-verify flow) keep their short TTL.
UPDATE case_track_tokens
   SET expires_at = '9999-12-31T23:59:59.000Z'
 WHERE source IN ('staff', 'sales');
