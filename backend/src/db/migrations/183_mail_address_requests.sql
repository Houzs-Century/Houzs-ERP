-- D1 test mirror of migrations-pg/20261124T1200_mail_address_requests.sql.
CREATE TABLE IF NOT EXISTS mail_address_requests (
  id                      TEXT PRIMARY KEY,
  company_id              INTEGER NOT NULL,
  user_id                 INTEGER NOT NULL,
  address                 TEXT NOT NULL,
  requested_department_id INTEGER,
  status                  TEXT NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'approved', 'rejected')),
  reason                  TEXT,
  decided_by              INTEGER,
  decided_at              TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mail_address_requests_open ON mail_address_requests (company_id, created_at) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS ix_mail_address_requests_user ON mail_address_requests (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mail_address_requests_open_user ON mail_address_requests (user_id) WHERE status = 'requested';
