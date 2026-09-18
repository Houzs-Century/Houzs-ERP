-- 20260908T1500_brand_share_tokens.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Creates `brand_share_tokens` — the unguessable token behind each BRAND's
--   public, no-login calendar share link (owner 2026-09-08: "each brand gets a
--   separate link — a brand only sees its OWN events"). Same shape as
--   `contractor_share_tokens` (20260903T1237): one live token per brand NAME
--   (matching the free-text `projects.brand` value the link filters on),
--   `revoked_at` as the kill switch for a leaked link. Text timestamps like the
--   rest of `public` (mig 0008). Additive + idempotent (CREATE TABLE IF NOT
--   EXISTS), so re-running is a no-op and no existing row is touched.
--
-- REVERSAL: DROP TABLE IF EXISTS brand_share_tokens;
-- Verified against: the DDL is the contractor_share_tokens shape already applied to prod (20260903T1237), column names swapped; not yet executed against prod — deploy.yml applies it on merge.

CREATE TABLE IF NOT EXISTS brand_share_tokens (
  token       text PRIMARY KEY,
  brand       text NOT NULL,
  revoked_at  text,
  created_by  bigint,
  created_at  text DEFAULT to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)
);

-- Resolve-by-brand for the admin "current link" lookup. No index on the
-- revoked flag (mig 0126 rationale: a boolean is not selective).
CREATE INDEX IF NOT EXISTS idx_brand_share_tokens_brand
  ON brand_share_tokens(brand);
