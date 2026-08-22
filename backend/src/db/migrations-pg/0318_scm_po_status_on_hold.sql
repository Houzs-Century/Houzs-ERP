-- 0318_scm_po_status_on_hold.sql
-- Add 'ON_HOLD' to scm.po_status so a Purchase Order can be paused.
--
-- Owner, 2026-08-21: "PO 加 hold / GR / PI also hold". The Sales Order has had
-- ON_HOLD since the beginning and the purchase side never did, so a buyer who
-- wanted to stop a supplier order mid-flight had only CANCELLED — which is
-- final, and which the ERP pushes to AutoCount where it cannot be un-cancelled.
-- Hold is the reversible answer that was missing.
--
-- WHAT IT BLOCKS (the app half, not this file): a PO on hold is not receivable,
-- because grns.ts filters on an ALLOW-list of SUBMITTED / PARTIALLY_RECEIVED —
-- so the block comes for free and cannot be forgotten. The recount in
-- recomputePoReceived is the half that had to be written: it re-derives a PO's
-- status from its lines and would have overwritten the hold on the next GRN
-- post, exactly as it already skips CANCELLED.
--
-- ALTER TYPE ... ADD VALUE only — kept ALONE in its own file. pg-migrate.mjs
-- wraps each file in one transaction; Postgres forbids USING a freshly-added
-- enum value in the same transaction that adds it, so no row may write or read
-- 'ON_HOLD' here. SET search_path = scm so the unqualified type resolves to
-- scm.* (pg-migrate's default search_path excludes scm). Idempotent via
-- IF NOT EXISTS. Same shape as 0042, which added DRAFT to this same type.
--
-- REVERSAL: IRREVERSIBLE — Postgres has no DROP VALUE for an enum type. An
-- added label is permanent. Retiring it means removing it from the app's
-- vocabulary (the VALID_STATUSES set and the status buckets), which is where
-- CLOSED was retired from the Sales Order on 2026-08-21; the label stays in the
-- type for ever either way.
-- Verified against: production schema read of scm.po_status on 2026-08-21 —
-- SUBMITTED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED, plus DRAFT from mig 0042.
-- No row anywhere carries ON_HOLD, because the label does not exist yet.

SET search_path = scm, public;

ALTER TYPE scm.po_status ADD VALUE IF NOT EXISTS 'ON_HOLD';
