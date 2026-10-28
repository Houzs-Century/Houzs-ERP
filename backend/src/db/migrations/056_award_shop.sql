-- 056_award_shop.sql
--
-- Houzs Points — Phase 2: redeemable award shop with stock + image +
-- admin-fulfilled redemption workflow.
--
-- Two tables:
--   • awards               — admin-curated catalogue. cost_points snapshots
--                            on the redemption row so a price change doesn't
--                            retroactively rewrite history.
--   • award_redemptions    — one row per user redeem. Lifecycle:
--                            pending -> shipped -> delivered, or cancelled.
--                            Cancel posts a balancing 'redeem_refund' row to
--                            point_transactions so the ledger stays correct.
--
-- Stock semantics:
--   • NULL  = unlimited (e.g. digital vouchers)
--   • >= 0  = decrement on successful redeem; reject when 0
--
-- Migrations are immutable: fix forward in a new file if anything here
-- turns out wrong.

CREATE TABLE awards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  cost_points  INTEGER NOT NULL,
  stock        INTEGER,                  -- NULL = unlimited
  image_r2_key TEXT,                     -- key in POD_BUCKET; NULL = no image yet
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_awards_active_sort ON awards(active, sort_order, id);

CREATE TABLE award_redemptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  award_id      INTEGER NOT NULL REFERENCES awards(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  cost_points   INTEGER NOT NULL,        -- snapshot at time of redeem
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','shipped','delivered','cancelled')),
  shipping_addr TEXT,
  admin_note    TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  shipped_at    TEXT,
  delivered_at  TEXT,
  cancelled_at  TEXT,
  cancelled_by  INTEGER REFERENCES users(id),
  ledger_tx_id  INTEGER REFERENCES point_transactions(id)
);
CREATE INDEX idx_redemptions_status        ON award_redemptions(status, created_at DESC);
CREATE INDEX idx_redemptions_user_created  ON award_redemptions(user_id, created_at DESC);
CREATE INDEX idx_redemptions_award         ON award_redemptions(award_id);
