-- 0255_service_category_normalise.sql
-- Nico 2026-08-04, follow-on to 0254. assr_cases.service_category was a
-- free-text field long before the lookup existed, so the 88 non-null rows
-- carry 17 spellings of five things ("BED FRAME ", "bedframe", "Bed frame",
-- "ACCERCORIES ", "DINNING TABLE", …). Fold them onto the five names the
-- dropdown now offers so the column can actually be grouped/reported on.
--
-- Judgement calls, all single rows, flagged to Nico:
--   CODY                 -> Bedframe    (ASSR/2607-009, item "BOTH CODY (Super single)")
--   DINNING TABLE        -> Dining      (ASSR/2608-004, item "AN-TABLE TOP")
--   ACCERCORIES          -> Accessories (ASSR/2607-010, cool silk airloft pillow)
--   Pillow / Bolster     -> Accessories (ASSR/2607-034, coolsilk latex pillow —
--                                        the category itself was retired in 0254)
--   Mattress / Bed frame -> Mattress    (ASSR/2606-048, "Mattress sanking /
--                                        Bedframe Saging" is genuinely both;
--                                        Mattress is the lead complaint)
--
-- NULL is left NULL — 724 rows never had a category and inventing one would
-- be worse than the gap. PG-only: the D1 mirror is a schema test bed and
-- holds none of these rows.

UPDATE assr_cases SET service_category = 'Bedframe'
 WHERE lower(btrim(service_category)) IN ('bedframe', 'bed frame', 'cody');

UPDATE assr_cases SET service_category = 'Sofa'
 WHERE lower(btrim(service_category)) = 'sofa';

UPDATE assr_cases SET service_category = 'Mattress'
 WHERE lower(btrim(service_category)) IN ('mattress', 'mattress / bed frame');

UPDATE assr_cases SET service_category = 'Dining'
 WHERE lower(btrim(service_category)) IN ('dining', 'dining table', 'dinning table');

UPDATE assr_cases SET service_category = 'Accessories'
 WHERE lower(btrim(service_category)) IN ('accessories', 'accercories', 'pillow / bolster');
