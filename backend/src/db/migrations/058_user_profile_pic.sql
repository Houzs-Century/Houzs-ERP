-- 058_user_profile_pic.sql
--
-- Adds a profile picture key on users — points at an R2 object inside
-- the existing POD_BUCKET binding. Same pattern used by award images
-- and POD photos: bytes live in R2, the DB carries the key, and the
-- frontend fetches via blob URL because <img src> can't carry the
-- bearer token.
--
-- Uploads land at `user/{id}/{ts}-{filename-sanitised}`.
--
-- Migrations are immutable: fix forward in a new file if anything
-- here turns out wrong.

ALTER TABLE users ADD COLUMN profile_pic_r2_key TEXT;
