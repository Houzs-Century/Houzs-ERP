-- Positions = the staff org dimension (department + position). It is the unit
-- the User-Management permission matrix is keyed on. Generalises the Sales-only
-- sales_positions table to ALL departments (sales_positions stays as-is to avoid
-- touching sales_reps logic). All statements idempotent (pg-migrate requirement).

CREATE TABLE IF NOT EXISTS positions (
  id            serial PRIMARY KEY,
  department_id integer REFERENCES departments(id),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  level         integer NOT NULL DEFAULT 100,
  sort_order    integer NOT NULL DEFAULT 100,
  active        integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The new scoping unit on users. Nullable: legacy users resolve via their role
-- matrix until backfilled (see hydrateAuthUser fallback).
ALTER TABLE users ADD COLUMN IF NOT EXISTS position_id integer REFERENCES positions(id);

CREATE INDEX IF NOT EXISTS idx_users_position ON users(position_id);

-- Invitations carry the org dimensions so accept-invite can apply them.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS position_id integer;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS department_id integer;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS manager_id integer;

-- Position page-access matrix — mirror of role_page_access but 4-level
-- (none/view/edit/full). The existing role_page_access stays 3-level
-- (none/partial/full); the app treats 'partial' as rank=view, so the two
-- coexist with no data migration.
CREATE TABLE IF NOT EXISTS position_page_access (
  position_id integer     NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  page_key    text        NOT NULL,
  level       text        NOT NULL CHECK (level IN ('none','view','edit','full')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (position_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_position_page_access_position ON position_page_access(position_id);
