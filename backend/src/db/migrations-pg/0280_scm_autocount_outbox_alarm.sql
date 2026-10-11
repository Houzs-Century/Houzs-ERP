-- scm.autocount_outbox — backoff, stall detection, and the alarm receipt.
--
-- WHY. 0277 made the queue DURABLE: a row, once written, survives a Worker
-- restart and a ZeroTier outage. What it does not do is make a LOST sync
-- impossible to MISS, and that is the owner's hard rule 4 — "a save that
-- succeeds in the ERP while its sync is silently lost must be impossible: a
-- durable queue plus a loud alarm... making failure VISIBLE." Three concrete
-- ways a lost sync is invisible today, each closed by one column here:
--
--   1. NO BACKOFF. The */5 sweep retries every pending row on every pass, so a
--      30-minute tunnel drop burns all six attempts in six sweeps and dead
--      letters the whole backlog. The link being down is exactly the condition
--      the queue exists to survive; it must not be the condition that empties
--      it into 'failed'. next_attempt_at spaces the retries out.
--
--   2. THE PERMANENT 'WAITING'. A conversion whose parent never gets an
--      AutoCount number returns 'waiting' and DELIBERATELY does not burn an
--      attempt (autocount-outbox.ts) — correct while the parent is merely one
--      sweep behind, wrong forever after. Such a row stays pending, never
--      fails, and is counted by nothing. first_waiting_at gives it an age, so
--      "waiting since the parent's create was skipped three days ago" can be
--      told apart from "waiting since 40 seconds ago".
--
--   3. NO RECEIPT FOR THE ALARM. A human-visible alarm must be raised ONCE per
--      row, not on every sweep for the rest of the row's life. alerted_at is
--      that receipt, and its NULLness is the thing the sweep looks for.
--
-- Nothing here deletes or rewrites history: the outbox is the audit trail of
-- what the ERP told AutoCount (0277's table comment), and the owner's first
-- hard rule is that nothing is ever deleted.

ALTER TABLE scm.autocount_outbox
  -- When this row may next be dispatched. now() for a fresh row, so an enqueue
  -- is still picked up by the very next sweep; pushed forward by dispatchOne
  -- after a retryable failure. NOT NULL + default keeps every pre-existing row
  -- immediately eligible, which is the safe direction: the worst case is the
  -- behaviour we already had.
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- First time this row reported 'waiting' (its parent had no AutoCount
  -- document yet). Cleared the moment it stops waiting, so the age it carries
  -- is the age of the CURRENT stall, not of some stall last week.
  ADD COLUMN IF NOT EXISTS first_waiting_at timestamptz,
  -- When a human-visible alarm was raised for this row. NULL = never alarmed.
  ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

-- The drain's lookup, now ordered by the gate it actually filters on. Replaces
-- 0277's autocount_outbox_pending_idx: a partial index over (created_at) can no
-- longer serve a query whose WHERE is next_attempt_at <= now(). Dropping it is
-- safe — it indexes nothing that is not covered here, and an index is not data.
DROP INDEX IF EXISTS scm.autocount_outbox_pending_idx;
CREATE INDEX IF NOT EXISTS autocount_outbox_due_idx
  ON scm.autocount_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

-- Finding rows that need an alarm without scanning the history.
CREATE INDEX IF NOT EXISTS autocount_outbox_unalerted_idx
  ON scm.autocount_outbox (status, updated_at)
  WHERE alerted_at IS NULL;

-- ── The dedupe index gets its company back ──────────────────────────────────
--
-- 0277 made the pending-dedupe index UNIQUE on dedupe_key ALONE, while several
-- keys are built from HUMAN document numbers — 'create_so:<docNo>' and
-- 'cancel:<docType>:<docNo>'. Two companies mint document numbers independently
-- (Houzs and 2990 both run SO-YYMM-NNN series), so the same number in two
-- companies collapses to ONE pending row: the second insert violates the index,
-- enqueueAcOp catches it as a benign "already queued", and one company's
-- document is never sent. Nothing anywhere would report that.
--
-- The intent was always ONE PENDING ROW PER INTENT, and an intent is
-- per-company: company_id is NOT NULL on this table, and every drain path
-- already re-checks the flag per company_id. Widening the index is the smaller
-- change than teaching every caller to prefix its key.
DROP INDEX IF EXISTS scm.autocount_outbox_dedupe_idx;
CREATE UNIQUE INDEX IF NOT EXISTS autocount_outbox_dedupe_idx
  ON scm.autocount_outbox (company_id, dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;

COMMENT ON COLUMN scm.autocount_outbox.next_attempt_at IS
  'Earliest time this row may be dispatched again. Exponential backoff set by dispatchOne so a tunnel outage cannot burn the attempt budget in one sweep.';
COMMENT ON COLUMN scm.autocount_outbox.first_waiting_at IS
  'When this row first reported waiting-on-parent. NULL when it is not waiting. Gives a permanent wait an age, which is the only thing that tells it apart from a normal one.';
COMMENT ON COLUMN scm.autocount_outbox.alerted_at IS
  'When a human-visible alarm (a WARNING notice in the ERP notification bell) was raised for this row. NULL = not yet alarmed; that is what the sweep looks for.';
