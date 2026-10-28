-- 0145_email_purchase_order_channel_on.sql — turn the supplier PO email channel ON.
--
-- ── READ THIS BEFORE MERGING ──
-- This repo pg-migrates PRODUCTION on every main deploy. The moment this file
-- merges and deploys, `email.purchase_order` is true on the live database and
-- the "Send to supplier" button on a confirmed PO starts delivering real email
-- to real suppliers. There is no staging step between merge and live for the
-- toggle itself. That is the owner's instruction (2026-07-19) and it is stated
-- here so nobody discovers it from an inbox.
--
-- WHAT DOES *NOT* CHANGE. Nothing sends by itself. The channel being ON is
-- necessary, not sufficient: a PO still leaves only when a person opens it,
-- presses Send to supplier and confirms the recipient in the dialog. There is no
-- scheduled sender, no agent path and no transition hook — the Procurement agent
-- raises DRAFT POs only, and a DRAFT is refused by the send route. The one
-- caller of POST /:id/send-to-supplier is that button.
--
-- WHY THE FLIP IS ITS OWN MIGRATION, separate from 0144's stamp columns: the two
-- answer to different risks. 0144 is structure and is safe to keep under any
-- circumstances; this file is the live switch. Splitting them means turning the
-- channel back off is a one-line revert that does not also drop the audit
-- columns recording what was already sent.
--
-- TO TURN IT BACK OFF WITHOUT A DEPLOY: the master switch and this per-channel
-- key are both editable from email settings (services/email.ts setSetting) —
-- flipping the row to {"value":false} is immediate and needs no migration.
-- isChannelEnabled is re-checked inside sendEmail and again at outbox drain, so
-- a message enqueued before the flip is not delivered after it.
--
-- Idempotent: an explicit UPDATE rather than 0132's INSERT ... ON CONFLICT DO
-- NOTHING, because the row already exists (0132 seeded it false) and DO NOTHING
-- would make this file a silent no-op. WHERE key = ... so it touches one row.

UPDATE app_settings
   SET value = '{"value":true}'
 WHERE key = 'email.purchase_order';

-- Belt and braces: if 0132 never ran on this database (a rebuild, a restored
-- snapshot), the UPDATE above matches nothing and the channel would read OFF via
-- FAIL_CLOSED_PURPOSES. Insert it in that case so the state after this migration
-- is the same everywhere it runs.
INSERT INTO app_settings (key, value) VALUES
  ('email.purchase_order', '{"value":true}')
ON CONFLICT (key) DO NOTHING;
