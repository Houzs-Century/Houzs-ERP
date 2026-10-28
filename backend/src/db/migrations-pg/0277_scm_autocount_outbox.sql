-- scm.autocount_outbox — the ERP -> AutoCount write-back queue.
--
-- WHY AN OUTBOX AND NOT A DIRECT CALL. After go-live the ERP is master and every
-- document it creates must appear in AutoCount (owner 2026-08-10). The AutoCount
-- half is a Windows service driving the licensed 2.2 SDK on the shop's own host,
-- reached over a tunnel. That host reboots, the tunnel drops, the SDK opens a
-- session per call. A synchronous push would make a salesperson's Save fail for
-- reasons that have nothing to do with the sale, and a dropped push would be
-- invisible. One row per intended operation makes the push RETRYABLE and
-- AUDITABLE: a year later "what did we tell AutoCount, when, and what did it
-- answer" is a SELECT, not a memory.
--
-- SHAPE follows email_outbox (0005 + 0269), the outbox this repo already runs:
-- status/attempts/last_error/created_at/sent_at, a partial index over pending
-- rows so the cron's next-batch lookup stays tiny, and a drain in the */5 cron.
-- Deliberately the same shape rather than a second pattern to learn.
--
-- SCHEMA. In `scm`, not `public`: the service client is created with
-- db.schema = 'scm' (db/supabase.ts), so sb.from('autocount_outbox') resolves
-- here. 0272 (scm.app_config) failed its first dispatch by getting this wrong.
--
-- THE PAYLOAD IS A SNAPSHOT, taken at enqueue time, never recomposed at drain.
-- It is the record of what the user's save actually produced. Recomposing at
-- drain would silently rewrite history when a later edit lands first, and would
-- make the audit trail a lie.

CREATE TABLE IF NOT EXISTS scm.autocount_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  bigint NOT NULL,
  -- The eight operations AcSyncService exposes, one per route it serves.
  op          text NOT NULL CHECK (op IN (
                'create_so', 'create_po', 'so_to_do', 'po_to_gr',
                'do_to_iv', 'gr_to_pi', 'cancel', 'edit')),
  -- The ERP document this operation is ABOUT (the target for a create/convert,
  -- the subject for a cancel/edit). doc_type is the AutoCount vocabulary the
  -- service speaks: SO / PO / DO / IV / GR / PI.
  doc_type    text NOT NULL CHECK (doc_type IN ('SO', 'PO', 'DO', 'IV', 'GR', 'PI')),
  doc_no      text NOT NULL,
  -- ERP row id as text. Deliberately untyped and un-FK'd: the six document
  -- tables do not share a key type, and an outbox row must survive its document
  -- being reworked. doc_no is the human handle, this is the machine one.
  doc_id      text,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  -- What AutoCount answered with. This is the half of the relationship map that
  -- points OUT of the ERP; the linked_ac_docno columns below are the half that
  -- points back IN, so the pair is traceable in both directions.
  ac_doc_no   text,
  -- Collapses duplicate PENDING work (a double-clicked Save, a retried request).
  -- NULL means "always enqueue" and is what an edit uses: two successive edits
  -- are two different intents and must both be applied, in order.
  dedupe_key  text,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

-- The drain's only lookup. Partial so it stays the size of the backlog, not of
-- the history (email_outbox's idx_email_outbox_pending, same reasoning).
CREATE INDEX IF NOT EXISTS autocount_outbox_pending_idx
  ON scm.autocount_outbox (created_at)
  WHERE status = 'pending';

-- One pending row per intent. Scoped to pending on purpose: a SENT row must not
-- block the next legitimate operation on the same document.
CREATE UNIQUE INDEX IF NOT EXISTS autocount_outbox_dedupe_idx
  ON scm.autocount_outbox (dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;

-- Answering "has this document been written to AutoCount, and as what" without
-- a sequential scan of the history.
CREATE INDEX IF NOT EXISTS autocount_outbox_doc_idx
  ON scm.autocount_outbox (company_id, doc_type, doc_no);

COMMENT ON TABLE scm.autocount_outbox IS
  'ERP -> AutoCount write-back queue. One row per intended AutoCount operation. Drained by the */5 cron (scm/lib/autocount-outbox.drainAutoCountOutbox) when scm.app_config key scm.autocount_writeback is on. Never delete rows: this is the audit trail of what the ERP told AutoCount.';


-- ── The ERP -> AutoCount document cross-reference ───────────────────────────
--
-- The write-back records the AutoCount document number back onto the ERP row so
-- the relationship map is traceable both ways. scm.mfg_sales_orders already has
-- linked_ac_docno (0271); the other five did not.
--
-- purchase_orders.linked_ac_docno is a KNOWN RECORDING GAP being closed here,
-- not a new column: import-ac-outstanding-po.mjs:314 added it at runtime with
-- its own ALTER, so it exists in production but appears in no migration
-- (docs/autocount-cutover-ledger.md §1 "坑二"). IF NOT EXISTS makes this a no-op
-- against the live database and makes the column real for every other
-- environment.
--
-- NULL is meaningful on all six: "this document has no AutoCount counterpart
-- yet". For a create that is the signal to CREATE rather than update.

ALTER TABLE scm.purchase_orders    ADD COLUMN IF NOT EXISTS linked_ac_docno text;
ALTER TABLE scm.delivery_orders    ADD COLUMN IF NOT EXISTS linked_ac_docno text;
ALTER TABLE scm.grns               ADD COLUMN IF NOT EXISTS linked_ac_docno text;
ALTER TABLE scm.sales_invoices     ADD COLUMN IF NOT EXISTS linked_ac_docno text;
ALTER TABLE scm.purchase_invoices  ADD COLUMN IF NOT EXISTS linked_ac_docno text;

CREATE INDEX IF NOT EXISTS purchase_orders_linked_ac_docno_idx    ON scm.purchase_orders (linked_ac_docno)   WHERE linked_ac_docno IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_orders_linked_ac_docno_idx    ON scm.delivery_orders (linked_ac_docno)   WHERE linked_ac_docno IS NOT NULL;
CREATE INDEX IF NOT EXISTS grns_linked_ac_docno_idx               ON scm.grns (linked_ac_docno)              WHERE linked_ac_docno IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_invoices_linked_ac_docno_idx     ON scm.sales_invoices (linked_ac_docno)    WHERE linked_ac_docno IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_invoices_linked_ac_docno_idx  ON scm.purchase_invoices (linked_ac_docno) WHERE linked_ac_docno IS NOT NULL;


-- ── The runtime toggle ──────────────────────────────────────────────────────
--
-- Same table and same grammar as the write freeze (0272): 'off' | 'all' |
-- comma-separated company ids. SEEDED OFF, and that is a hard requirement of
-- this change, not a default worth revisiting casually: turning the write-back
-- on is an explicit act against a live account book, never a side effect of
-- running a migration.
INSERT INTO scm.app_config (key, value, description)
VALUES ('scm.autocount_writeback', 'off',
        'ERP -> AutoCount write-back. off = nothing is queued and nothing is sent. Set to a company id list (Houzs is 1) to enable. Read by scm/lib/autocount-writeback-flag.ts.')
ON CONFLICT (key) DO NOTHING;
