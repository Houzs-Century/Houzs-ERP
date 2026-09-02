-- REVERSAL:
--   ALTER TABLE scm.payment_vouchers
--     DROP COLUMN IF EXISTS checked_at, DROP COLUMN IF EXISTS checked_by;
--   (Additive only — two marker columns nothing else references. Dropping
--   them returns 0339's three-step cycle exactly; any checked-not-yet-
--   approved voucher simply reads as prepared again and walks the shorter
--   path. No money value lives here.)
--
-- pv_checked — the owner's four layers (2026-09-02, his words: draft 就是
-- raw draft… 然后prepare 后会多两层checking, 一层是checked，一层是approved,
-- 当approved 了才会进gl).
--
--   Draft     status DRAFT, no markers        — raw, freely editable
--   Prepared  submitted_at set                — declared ready, STILL editable
--   Checked   checked_at set                  — first yes; LOCKED from here
--   Approved  approved_at set → GL auto-posts — second yes IS the posting
--
-- MARKER COLUMNS, NOT NEW STATUSES — the 0324 lesson, third time running.
-- status stays DRAFT through the whole cycle; POSTED arrives when approval
-- posts the JE. Any reject at check or approve clears ALL markers back to
-- Draft (一律退回 Draft). Whether the money truly left the bank stays bank
-- reconciliation's question, not this table's.
--
-- checked_by mirrors submitted_by/approved_by: the actor's display name,
-- written by the route from the authed houzsUser — same convention, same
-- audit trail alongside.

ALTER TABLE scm.payment_vouchers
  ADD COLUMN IF NOT EXISTS checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS checked_by text;

COMMENT ON COLUMN scm.payment_vouchers.checked_at IS
  'First yes of the two-layer check (owner 2026-09-02). Set by POST /:id/check, cleared by reject. Locks editing; Daily Bank pending counts vouchers from here.';
