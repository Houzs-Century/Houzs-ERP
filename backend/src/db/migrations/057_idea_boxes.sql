-- 057_idea_boxes.sql
--
-- Houzs Points — Phase 3: innovation + suggestion boxes with voting.
--
-- Two distinct surfaces sharing a polymorphic vote table:
--
--   • innovations  — strategic ideas. Status flow:
--       review -> accepted -> in_progress -> shipped -> declined
--       'shipped' awards points.innovation_shipped to the submitter.
--
--   • suggestions  — operational fixes. Status flow:
--       review -> approved -> declined
--       'approved' awards points.suggestion_approved to the submitter.
--
--   • votes        — polymorphic upvotes. UNIQUE(target_type,target_id,user_id)
--                    means one vote per (idea, user). Each vote credits the
--                    post's author with points.upvote_received and counts
--                    toward the recipient's weekly streak.
--
-- All point awards are emitted via services/points.ts and write to
-- point_transactions; the streak rollup query already includes
-- 'upvote_received' in its IN-list, so Phase 1 + Phase 3 hook up
-- without further plumbing.
--
-- Migrations are immutable: fix forward in a new file if anything here
-- turns out wrong.

CREATE TABLE innovations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  tags           TEXT,
  status         TEXT NOT NULL DEFAULT 'review'
                 CHECK (status IN ('review','accepted','in_progress','shipped','declined')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  decline_reason TEXT,
  awarded_at     TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_innovations_status_created ON innovations(status, created_at DESC);
CREATE INDEX idx_innovations_user_created   ON innovations(user_id, created_at DESC);

CREATE TABLE suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  body           TEXT,
  status         TEXT NOT NULL DEFAULT 'review'
                 CHECK (status IN ('review','approved','declined')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  decline_reason TEXT,
  awarded_at     TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_suggestions_status_created ON suggestions(status, created_at DESC);
CREATE INDEX idx_suggestions_user_created   ON suggestions(user_id, created_at DESC);

CREATE TABLE votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('innovation','suggestion')),
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (target_type, target_id, user_id)
);
CREATE INDEX idx_votes_target ON votes(target_type, target_id);
