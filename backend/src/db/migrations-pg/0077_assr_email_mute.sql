-- Per-user opt-out of ASSR service-case digest/escalation/alert emails.
-- The user keeps service_cases.manage (still views + manages cases); this
-- flag only suppresses the outbound mail. Checked in the manager-recipient
-- queries in services/assrAlerts.ts + services/assrEscalation.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS assr_email_muted integer NOT NULL DEFAULT 0;
