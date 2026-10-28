-- 0060_product_model_photos_and_hero_meta.sql
--
-- Backend window · item 4b (file uploads). Two additive schema bits:
--
--   1. scm.product_model_photos
--        Multi-photo gallery for a product Model (4a frontend's PhotoGallery
--        component already calls the expected endpoint shapes; this table is
--        what those endpoints persist to). One row per uploaded photo, with
--        a stable sort_order + a single is_primary flag per model. The
--        existing single product_models.photo_url stays untouched — it's the
--        legacy "Photo" card on ProductModelDetail, kept for back-compat. New
--        gallery uploads land here.
--
--   2. scm.categories — add hero_focal_x / hero_focal_y / hero_alt
--        Drives object-position on the front-of-house category banner. The
--        existing hero_image_key column stays as the R2 key for the cover
--        image; focal_x/y are normalized 0–1, alt is screen-reader copy.
--
-- Idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Re-running
-- the file is a no-op. Wrapped in one transaction by pg-migrate.
--
-- DOWN (run manually if reverting):
--   DROP INDEX IF EXISTS scm.idx_product_model_photos_model_sort;
--   DROP INDEX IF EXISTS scm.uq_product_model_photos_one_primary;
--   DROP TABLE IF EXISTS scm.product_model_photos;
--   ALTER TABLE scm.categories DROP COLUMN IF EXISTS hero_focal_x;
--   ALTER TABLE scm.categories DROP COLUMN IF EXISTS hero_focal_y;
--   ALTER TABLE scm.categories DROP COLUMN IF EXISTS hero_alt;

SET search_path = scm, public;

-- 1. product_model_photos -----------------------------------------------------

CREATE TABLE IF NOT EXISTS product_model_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    uuid NOT NULL REFERENCES product_models(id) ON DELETE CASCADE,
  r2_key      text NOT NULL,
  -- Optional thumbnail key. Reserved for a future "generate 300x300 on upload"
  -- step; uploads land with null today and the frontend falls back to the
  -- full-size image. Adding the column now so the route shape is stable.
  thumb_key   text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_primary  boolean NOT NULL DEFAULT false,
  mime_type   text,
  size_bytes  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- created_by mirrors product_models.created_by (the operator who uploaded).
  -- Nullable because some upload paths (system / batch import) may not carry
  -- the user id; the row is still useful without it.
  created_by  uuid
);

-- Speed up "list photos for one model in display order".
CREATE INDEX IF NOT EXISTS idx_product_model_photos_model_sort
  ON product_model_photos (model_id, sort_order, created_at);

-- At most one primary photo per model. Enforced as a partial unique index so
-- the constraint scales without blocking inserts of non-primary rows.
-- (A plain UNIQUE(model_id, is_primary) would reject any second non-primary
-- photo since is_primary defaults to false — wrong shape.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_model_photos_one_primary
  ON product_model_photos (model_id) WHERE is_primary;

-- 2. categories.hero_focal_x / hero_focal_y / hero_alt -----------------------

-- Focal point coordinates, normalized to [0, 1]. NULL means "default to
-- centre 0.5/0.5"; the API surfaces them with sensible defaults so the
-- frontend never sees nulls.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS hero_focal_x real;
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS hero_focal_y real;

-- Screen-reader alt text for the hero image. Free-form, soft 200-char cap
-- enforced at the API layer.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS hero_alt text;

-- Sanity-bound the focal range so a bad PATCH can't write nonsense.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'categories_hero_focal_x_range'
      AND conrelid = 'scm.categories'::regclass
  ) THEN
    ALTER TABLE categories
      ADD CONSTRAINT categories_hero_focal_x_range
      CHECK (hero_focal_x IS NULL OR (hero_focal_x >= 0 AND hero_focal_x <= 1));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'categories_hero_focal_y_range'
      AND conrelid = 'scm.categories'::regclass
  ) THEN
    ALTER TABLE categories
      ADD CONSTRAINT categories_hero_focal_y_range
      CHECK (hero_focal_y IS NULL OR (hero_focal_y >= 0 AND hero_focal_y <= 1));
  END IF;
END $$;
