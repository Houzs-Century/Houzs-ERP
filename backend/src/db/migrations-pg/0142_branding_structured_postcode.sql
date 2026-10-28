-- 0142_branding_structured_postcode.sql (Postgres)
-- Owner ask (2026-07-18): the COMPANY's own address (Settings -> Branding, the
-- identity printed on document letterheads) should be structured so a postcode
-- can be filled SEPARATELY from the address lines, instead of one free-text blob.
--
-- WHY no DDL: branding is NOT a table — it is a single JSON object per company in
-- the app_settings key/value store (key 'branding' for HOUZS, 'branding:<CODE>'
-- for every other company; see services/branding.ts + migrations 0038/0094).
-- Adding a field therefore means adding a JSON key, not a column. The read layer
-- (normalize/normalizeBranding) already defaults a missing key to "", so this
-- migration is NOT required for the feature to work — it only pre-populates the
-- new `postcode` key from the postcode already embedded in the legacy address so
-- the owner sees it filled in rather than blank.
--
-- WHY it is safe to auto-apply to PROD:
--   * ADDITIVE + NO DATA LOSS — it only adds a `postcode` key via jsonb_set; the
--     legacy `address` text is left byte-for-byte untouched, so every letterhead
--     (which falls back to `address`) renders identically. The postcode is only
--     woven into the printed address when it is set AND not already present in
--     the address text (composeBrandingAddress), so HOUZS — whose address already
--     contains "43300" — prints unchanged.
--   * FENCED CAST — only 'branding%' rows are ever cast to jsonb. Non-branding
--     app_settings rows (e.g. '{"value":false}' email toggles) are excluded by
--     the MATERIALIZED CTE, which forces the key filter to run before any cast,
--     so a hypothetical non-JSON row elsewhere can never make the cast throw and
--     block the deploy. Every branding writer serializes JSON (migration seeds +
--     setBrandingForCompany's JSON.stringify), so the branding rows are always
--     valid JSON objects.
--   * IDEMPOTENT — the guard `NOT (value ? 'postcode')` means a re-run (or a row
--     an owner already saved with a postcode) is skipped; re-applying changes
--     nothing.

WITH branding_rows AS MATERIALIZED (
  -- MATERIALIZED = optimization fence: the key filter is evaluated here, so the
  -- ::jsonb casts below only ever touch 'branding%' rows, never other settings.
  SELECT key, value
  FROM app_settings
  WHERE key LIKE 'branding%'
)
UPDATE app_settings a
SET value = jsonb_set(
      b.value::jsonb,
      '{postcode}',
      to_jsonb(substring(b.value::jsonb->>'address' FROM '[0-9]{5}')),
      true
    )::text
FROM branding_rows b
WHERE a.key = b.key
  AND jsonb_typeof(b.value::jsonb) = 'object'
  AND NOT (b.value::jsonb ? 'postcode')
  AND b.value::jsonb->>'address' ~ '[0-9]{5}';
