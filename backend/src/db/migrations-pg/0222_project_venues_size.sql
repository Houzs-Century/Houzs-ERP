-- Owner asked to record each venue's physical size on the Project Maintenance
-- venue master (e.g. "12,000 sqft" or a hall label like "Hall 3"). Kept as free
-- text because the owner writes both numeric areas and named halls; no parsing
-- or unit is enforced. Nullable so every existing venue row stays valid.
ALTER TABLE project_venues ADD COLUMN IF NOT EXISTS size text;
