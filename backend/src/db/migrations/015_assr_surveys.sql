-- 015_assr_surveys.sql
-- Tokenized customer satisfaction survey — issued when a case closes,
-- dispatcher shares the link manually (WhatsApp/SMS/email), customer
-- submits rating + comment without logging in.

CREATE TABLE IF NOT EXISTS assr_survey_tokens (
  token TEXT PRIMARY KEY,             -- random string in the URL
  assr_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,                    -- nullable; null = never expires
  submitted_at TEXT,                  -- filled on submission
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_survey_assr ON assr_survey_tokens(assr_id);
