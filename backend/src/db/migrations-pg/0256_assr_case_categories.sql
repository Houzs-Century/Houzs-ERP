-- 0256_assr_case_categories.sql
-- Nico 2026-08-04: a case can genuinely be more than one product category
-- (ASSR/2606-048 is "Mattress sanking / Bedframe Saging" — mattress AND
-- bedframe), so Product Category becomes multi-select.
--
-- assr_cases.service_category stays put and stays the DISPLAY value: it is
-- read in ~50 places (list column, CSV export, print, customer portal,
-- supplier portal, mobile) that only ever render it, and rewriting all of
-- them to join buys nothing. From here it holds the comma-joined names and
-- is written ONLY by setCaseCategories() in services/assr.ts, alongside the
-- rows below — one writer, so the two cannot drift.
--
-- This table is the queryable truth: "how many bedframe cases" must count a
-- Bedframe+Mattress case once on each side, which a comma-joined string
-- cannot do.

CREATE TABLE IF NOT EXISTS assr_case_categories (
  case_id BIGINT NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  slug    TEXT   NOT NULL,
  PRIMARY KEY (case_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_assr_case_categories_slug ON assr_case_categories(slug);

-- Backfill. 0255 already folded the 17 legacy spellings onto the five
-- lookup names, so a case-insensitive name match is enough; anything that
-- still fails to match (a hand-typed value added between 0255 and this
-- migration) keeps its display string and simply has no row here, which is
-- the same "uncategorised" state as the 724 NULLs.
INSERT INTO assr_case_categories (case_id, slug)
SELECT c.id, p.slug
  FROM assr_cases c
  JOIN assr_product_categories p
    ON lower(btrim(p.name)) = lower(btrim(c.service_category))
 WHERE c.service_category IS NOT NULL AND btrim(c.service_category) <> ''
ON CONFLICT DO NOTHING;
