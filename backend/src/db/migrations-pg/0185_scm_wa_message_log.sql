-- 0185_scm_wa_message_log.sql — WhatsApp (Seampify) send log for the Delivery
-- Planning board's "Send Message" action.
--
-- Owner 2026-07-22: the board takes over the sheet-era "BulkSend" Apps Script.
-- A send bundles ALL of a customer's selected orders into ONE WhatsApp message
-- (the sheet's payload shape: phone + total_item + ref_N/branding_N/...), so a
-- batch is one API call per PHONE covering several doc numbers. This table
-- mirrors the sheet's "Delivery Logs" tab, but one row PER DOC (batch_id ties a
-- phone's docs together) so the board can show a per-row send status cheaply.
--
-- HOUSE STYLE: no runtime self-apply, IF NOT EXISTS throughout, plain
-- statements, SET search_path so unqualified scm types resolve.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.wa_message_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id   uuid NOT NULL,
  company_id bigint,
  doc_no     text NOT NULL,
  phone      text NOT NULL,
  payload    text NOT NULL,
  http_code  integer,
  success    boolean NOT NULL DEFAULT false,
  error      text,
  source     text NOT NULL DEFAULT 'delivery-planning',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_log_doc     ON scm.wa_message_log (doc_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_log_batch   ON scm.wa_message_log (batch_id);
CREATE INDEX IF NOT EXISTS idx_wa_log_created ON scm.wa_message_log (created_at DESC);
