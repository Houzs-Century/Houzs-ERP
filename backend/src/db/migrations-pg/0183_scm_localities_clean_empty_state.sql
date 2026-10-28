-- 0183_scm_localities_clean_empty_state.sql
--
-- Delete the empty / placeholder state rows in scm.my_localities that
-- surfaced under Malaysia + Singapore in the Localities Maintenance UI
-- with STATE = '—' / CODE = '—'. These are unpickable (nothing valid to
-- select) and pre-date mig 0181's canonical seed.
--
-- Owner directive 2026-07-23: "空的 clear 掉".
--
-- WHY A SEPARATE MIGRATION (not folded into mig 0181):
--   Mig 0181 was already merged + applied before this cleanup landed —
--   pg-migrate tracks by full filename and treats an applied file as
--   immutable, so editing 0181 in place would either be silently skipped
--   (still applied) or fail the checksum gate (mig 0173 pattern). This
--   file ships the DELETE as a fresh numbered migration instead.
--
-- SCOPE:
--   DELETE where state is NULL, empty, a hyphen, or an em/en-dash.
--   scm.my_localities is one row per (postcode, city, state) so this
--   also drops the placeholder's stray (city, postcode) tuples. No
--   supplier / venue / warehouse row references these — their state
--   value would be '—' too, and mig 0175 canonicalize left the '—'
--   pass-through so it wasn't rewritten to anything valid; any such
--   row is already broken and needs an operator re-pick.

BEGIN;

DELETE FROM scm.my_localities
 WHERE state IS NULL
    OR btrim(state) = ''
    OR btrim(state) IN ('-', '—', '–');

COMMIT;
