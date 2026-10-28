-- D1 / SQLite parity for migrations-pg/0229_venue_canonicalize.sql — fold the
-- known showroom-venue aliases ("PJ Showroom" and friends) to "2990s PJ" at
-- write time, so the test mirror behaves the way production does.
--
-- KEEP IN SYNC with backend/src/scm/lib/canonical-venue.ts,
-- backend/scripts/backfill-canonicalize-venue.mjs, and scm.canonicalize_venue()
-- in migrations-pg/0229. A divergence between the copies is the exact bug this
-- guard exists to prevent.
--
-- Differences from the Postgres file, all forced by SQLite:
--   * No plpgsql, so no shared mapper function — the alias list is inline, and
--     a BEFORE trigger cannot assign to NEW, so these are AFTER triggers that
--     re-UPDATE the row. Recursive triggers are off by default in SQLite, and
--     the WHEN clause excludes the canonical value anyway, so it cannot loop.
--   * Only the two PMS tables exist here. scm.mfg_sales_orders and
--     scm.warehouses live in Postgres only, so their triggers have no mirror.
--   * lower(trim(...)) only — no inner-whitespace collapse (SQLite has no
--     regexp). No alias in the map contains inner whitespace beyond a single
--     space, and this matches what backfill-canonicalize-venue.mjs already
--     keys on.
-- Blank and NULL venues are untouched: the WHEN clauses require a non-NULL
-- value that is a KNOWN alias.

CREATE TRIGGER IF NOT EXISTS trg_projects_canonicalize_venue_ins
AFTER INSERT ON projects
FOR EACH ROW
WHEN NEW.venue IS NOT NULL
 AND NEW.venue <> '2990s PJ'
 AND lower(trim(NEW.venue)) IN
     ('pj showroom','pj-showroom','pjshowroom','2990s pj','2990spj','2990 pj','2990pj')
BEGIN
  UPDATE projects SET venue = '2990s PJ' WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_canonicalize_venue_upd
AFTER UPDATE OF venue ON projects
FOR EACH ROW
WHEN NEW.venue IS NOT NULL
 AND NEW.venue <> '2990s PJ'
 AND lower(trim(NEW.venue)) IN
     ('pj showroom','pj-showroom','pjshowroom','2990s pj','2990spj','2990 pj','2990pj')
BEGIN
  UPDATE projects SET venue = '2990s PJ' WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_venues_canonicalize_name_ins
AFTER INSERT ON project_venues
FOR EACH ROW
WHEN NEW.name IS NOT NULL
 AND NEW.name <> '2990s PJ'
 AND lower(trim(NEW.name)) IN
     ('pj showroom','pj-showroom','pjshowroom','2990s pj','2990spj','2990 pj','2990pj')
BEGIN
  UPDATE project_venues SET name = '2990s PJ' WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_project_venues_canonicalize_name_upd
AFTER UPDATE OF name ON project_venues
FOR EACH ROW
WHEN NEW.name IS NOT NULL
 AND NEW.name <> '2990s PJ'
 AND lower(trim(NEW.name)) IN
     ('pj showroom','pj-showroom','pjshowroom','2990s pj','2990spj','2990 pj','2990pj')
BEGIN
  UPDATE project_venues SET name = '2990s PJ' WHERE id = NEW.id;
END;
